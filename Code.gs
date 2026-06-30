/*************************************************************************************
 * ระบบข้อมูลการป้องกันและปราบปรามผู้มีอิทธิพล จังหวัดหนองบัวลำภู
 * Backend : Google Apps Script (Web App) + Google Sheets + JSONP
 * -----------------------------------------------------------------------------------
 * ความสามารถ
 *   - อ่านข้อมูลล่าสุด (read / meta)
 *   - ยืนยันรหัสผ่านรายอำเภอ (auth) แบบ SHA-256 (ไม่เก็บรหัสจริง)
 *   - บันทึก/แก้ไขข้อมูลรายอำเภอ (save) — แต่ละอำเภอใช้ PIN ของตนเอง
 *   - นำเข้าหลายแถวพร้อมกัน (bulk) — เฉพาะ PIN ผู้ดูแลระบบ
 * -----------------------------------------------------------------------------------
 * วิธีติดตั้ง (ทำครั้งเดียว)
 *   1) สร้าง Google Sheet ใหม่ คัดลอก ID จาก URL มาใส่ใน SHEET_ID ด้านล่าง
 *   2) วางโค้ดนี้ใน Extensions > Apps Script
 *   3) รันฟังก์ชัน setup() หนึ่งครั้ง (สร้างหัวตาราง + ใส่ข้อมูลตั้งต้นจากแผนปฏิบัติการ)
 *   4) Deploy > New deployment > Web app
 *        - Execute as : Me
 *        - Who has access : Anyone
 *      คัดลอก URL ที่ได้ (ลงท้าย /exec) ไปวางใน index.html และ input.html (ตัวแปร API)
 *
 * วิธีเปลี่ยนรหัสผ่าน
 *   - แก้ค่า PIN ในฟังก์ชัน printHashes() แล้วรัน → ดูค่า hash ใน Log
 *     นำ hash ที่ได้มาวางทับใน PIN_HASH ด้านล่าง (รหัสจริงจะไม่ถูกเก็บในไฟล์)
 *************************************************************************************/

/** ====== ตั้งค่า ====== */
var SHEET_ID  = 'ใส่_GOOGLE_SHEET_ID_ตรงนี้';   // <-- แก้เป็น ID ชีตของคุณ
var DATA_TAB  = 'Data';
var SALT      = 'nbl-influence-2569';            // เกลือผสมรหัส (เปลี่ยนได้ แต่ต้อง re-hash)

/** รายชื่ออำเภอ (ลำดับตามเอกสาร) */
var DISTRICTS = ['เมืองหนองบัวลำภู','ศรีบุญเรือง','นากลาง','โนนสัง','สุวรรณคูหา','นาวัง'];

/** เดือนตามปีงบประมาณ (ต.ค.=1 ... ก.ย.=12) */
var FISCAL_MONTHS = ['ต.ค.','พ.ย.','ธ.ค.','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.'];

/** หัวคอลัมน์ของชีต (ลำดับสำคัญ) */
var HEADERS = ['fiscalYear','month','monthOrder','district',
  'red','yellow','suppressed','remaining','targetPct','resultPct',
  'complaints','patrols','operations','arrests',
  'status','note','updatedAt','updatedBy'];

/** ฟิลด์ตัวเลขที่ต้องแปลงเป็น Number */
var NUM_FIELDS = ['fiscalYear','monthOrder','red','yellow','suppressed','remaining',
  'targetPct','resultPct','complaints','patrols','operations','arrests'];

/**
 * รหัสผ่าน (เก็บเป็น SHA-256 เท่านั้น — รหัสจริงไม่อยู่ในไฟล์)
 * ค่าเริ่มต้น (โปรดเปลี่ยน): เมือง=1101, ศรีบุญเรือง=1102, นากลาง=1103,
 *                          โนนสัง=1104, สุวรรณคูหา=1105, นาวัง=1106, ผู้ดูแล=9999
 */
var PIN_HASH = {
  'เมืองหนองบัวลำภู':'815beff5666abf0fa5bb0c66a8abc1ba3c940d66afa99d9fcafa97476a0aa264',
  'ศรีบุญเรือง'    :'14d6e8c9d2736004311705514862e2a165a579357365de196024151c2fcdd524',
  'นากลาง'         :'b02a56f3121e6a8f245c7ea070de92817f9a18c99935c98ea36426ed233d929a',
  'โนนสัง'         :'caa9fe6f839a8a9536b1d5452268c9b9107c5b325fcfe942b4179a99ba7bf3a7',
  'สุวรรณคูหา'     :'51f90d9824f62f8162fa116b439b431d35d7e16d42968562efd5b35d54e2e968',
  'นาวัง'          :'7913f81946168acdd759576c8be6f6da1156d4deb87dcae891ac79ca2f27b459',
  'ADMIN'          :'bc3fbccda9d5c8a903103982f07dd504c5e6aa045e6f83083f5cd3897a9adaed'
};

/** ====== Utilities ====== */
function sha256Hex(s){
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return raw.map(function(b){ return ('0'+(b & 0xFF).toString(16)).slice(-2); }).join('');
}
function hashOf(district, pin){ return sha256Hex(district + '|' + pin + '|' + SALT); }

/** ตรวจรหัส: คืน role = 'admin' | 'district' | null */
function checkPin(district, pin){
  pin = String(pin||'').trim();
  if (!pin) return null;
  if (PIN_HASH['ADMIN'] && hashOf('ADMIN', pin) === PIN_HASH['ADMIN']) return 'admin';
  if (district && PIN_HASH[district] && hashOf(district, pin) === PIN_HASH[district]) return 'district';
  return null;
}

function getSheet(){
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(DATA_TAB);
  if (!sh){ sh = ss.insertSheet(DATA_TAB); sh.appendRow(HEADERS); }
  return sh;
}

function readAll(){
  var sh = getSheet();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0];
  var idx = {}; head.forEach(function(h,i){ idx[h]=i; });
  var rows = [];
  for (var r=1; r<values.length; r++){
    var row = values[r];
    if (!row[idx['district']]) continue;
    var o = {};
    HEADERS.forEach(function(h){
      var v = (idx[h]!=null) ? row[idx[h]] : '';
      o[h] = v;
    });
    NUM_FIELDS.forEach(function(f){ o[f] = Number(o[f]||0); });
    rows.push(o);
  }
  return rows;
}

/** key เฉพาะของแถว = ปีงบ + เดือน + อำเภอ */
function rowKey(o){ return [o.fiscalYear, o.monthOrder, o.district].join('#'); }

/** upsert แถวเดียว */
function upsertRow(obj){
  var sh = getSheet();
  var values = sh.getDataRange().getValues();
  var head = values[0]; var idx = {}; head.forEach(function(h,i){ idx[h]=i; });
  var key = rowKey(obj);
  var targetRow = -1;
  for (var r=1; r<values.length; r++){
    var k = [Number(values[r][idx['fiscalYear']]), Number(values[r][idx['monthOrder']]), values[r][idx['district']]].join('#');
    if (k === key){ targetRow = r+1; break; }
  }
  var line = HEADERS.map(function(h){ return (obj[h]!=null)?obj[h]:''; });
  if (targetRow > 0){ sh.getRange(targetRow,1,1,HEADERS.length).setValues([line]); }
  else { sh.appendRow(line); }
}

/** ====== Web entry (JSONP) ====== */
function doGet(e){
  var p = (e && e.parameter) ? e.parameter : {};
  var cb = p.callback || 'callback';
  var out;
  try {
    var action = p.action || 'read';
    if (action === 'meta'){
      out = { ok:true, districts:DISTRICTS, months:FISCAL_MONTHS, headers:HEADERS, serverTime:new Date().toISOString() };
    } else if (action === 'read'){
      var rows = readAll();
      if (p.fy) rows = rows.filter(function(o){ return Number(o.fiscalYear)===Number(p.fy); });
      out = { ok:true, rows:rows, count:rows.length };
    } else if (action === 'auth'){
      var role = checkPin(p.district, p.pin);
      out = role ? { ok:true, role:role } : { ok:false, error:'รหัสผ่านไม่ถูกต้อง' };
    } else if (action === 'save'){
      var role = checkPin(p.district, p.pin);
      if (!role) { out = { ok:false, error:'รหัสผ่านไม่ถูกต้อง หรือไม่มีสิทธิ์แก้ไขอำเภอนี้' }; }
      else {
        var obj = buildObjFromParams(p);
        obj.updatedAt = new Date().toISOString();
        obj.updatedBy = (role==='admin' ? 'admin' : obj.district);
        upsertRow(obj);
        out = { ok:true, saved:rowKey(obj) };
      }
    } else if (action === 'bulk'){
      var role = checkPin('ADMIN', p.pin);
      if (role !== 'admin'){ out = { ok:false, error:'การนำเข้าหลายแถวต้องใช้รหัสผู้ดูแลระบบ' }; }
      else {
        var arr = JSON.parse(p.rows || '[]');
        var n=0;
        arr.forEach(function(o){
          NUM_FIELDS.forEach(function(f){ o[f]=Number(o[f]||0); });
          o.month = FISCAL_MONTHS[(o.monthOrder||1)-1] || o.month || '';
          o.updatedAt = new Date().toISOString();
          o.updatedBy = 'admin(import)';
          upsertRow(o); n++;
        });
        out = { ok:true, imported:n };
      }
    } else {
      out = { ok:false, error:'ไม่รู้จัก action: '+action };
    }
  } catch(err){
    out = { ok:false, error:String(err) };
  }
  return ContentService
    .createTextOutput(cb + '(' + JSON.stringify(out) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function buildObjFromParams(p){
  var o = {};
  HEADERS.forEach(function(h){ if (p[h]!=null) o[h]=p[h]; });
  NUM_FIELDS.forEach(function(f){ o[f]=Number(o[f]||0); });
  o.month = FISCAL_MONTHS[(o.monthOrder||1)-1] || o.month || '';
  return o;
}

/** ====== ติดตั้งครั้งแรก / ยูทิลิตี้ ====== */

/** สร้างหัวตาราง + ใส่ข้อมูลตั้งต้นจากแผนปฏิบัติการ (8 เดือนแรก ปีงบ 2569) */
function setup(){
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(DATA_TAB);
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet(DATA_TAB);
  sh.appendRow(HEADERS);

  // red, yellow ตามตารางในเอกสาร ; ปัจจุบันคงเหลือ = 0 ทุกอำเภอ ; เป้าหมาย/ผล = 100%
  var seed = {
    'เมืองหนองบัวลำภู':{red:0,yellow:2},
    'ศรีบุญเรือง'    :{red:0,yellow:0},
    'นากลาง'         :{red:0,yellow:2},
    'โนนสัง'         :{red:0,yellow:0},
    'สุวรรณคูหา'     :{red:1,yellow:0},
    'นาวัง'          :{red:0,yellow:2}
  };
  var fy = 2569, mo = 8; // พ.ค. = ลำดับที่ 8 ของปีงบประมาณ
  var now = new Date().toISOString();
  DISTRICTS.forEach(function(d){
    var s = seed[d] || {red:0,yellow:0};
    var suppressed = s.red + s.yellow; // ถอดถอน/ปราบปรามแล้วทั้งหมด
    var line = {
      fiscalYear:fy, month:FISCAL_MONTHS[mo-1], monthOrder:mo, district:d,
      red:s.red, yellow:s.yellow, suppressed:suppressed, remaining:0,
      targetPct:100, resultPct:100,
      complaints:0, patrols:0, operations:0, arrests:0,
      status:'ถอดถอนรายชื่อจากผู้มีอิทธิพลแล้ว', note:'',
      updatedAt:now, updatedBy:'setup'
    };
    sh.appendRow(HEADERS.map(function(h){ return line[h]; }));
  });
  SpreadsheetApp.flush();
  Logger.log('setup เสร็จสิ้น: ใส่ข้อมูล %s อำเภอ', DISTRICTS.length);
}

/** พิมพ์ค่า hash สำหรับ PIN ที่ต้องการ — แก้ map ด้านล่างแล้วรัน ดูผลใน Execution log */
function printHashes(){
  var pins = {
    'เมืองหนองบัวลำภู':'1101',
    'ศรีบุญเรือง'    :'1102',
    'นากลาง'         :'1103',
    'โนนสัง'         :'1104',
    'สุวรรณคูหา'     :'1105',
    'นาวัง'          :'1106',
    'ADMIN'          :'9999'
  };
  Object.keys(pins).forEach(function(d){
    Logger.log("'%s':'%s',", d, hashOf(d, pins[d]));
  });
}
