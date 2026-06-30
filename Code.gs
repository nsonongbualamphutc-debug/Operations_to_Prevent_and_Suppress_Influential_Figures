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
 * วิธีเปลี่ยนรหัสผ่าน (รหัสจริงจะไม่ถูกเก็บในไฟล์)
 *   1) เมนูซ้าย Project Settings > Script Properties > Add property
 *        - key: GEN_DISTRICT   value: ชื่ออำเภอ (หรือ ADMIN)
 *        - key: GEN_PIN        value: รหัสที่ต้องการ
 *   2) รันฟังก์ชัน genHash() แล้วดูค่า hash ที่ View > Logs
 *   3) นำ hash ไปวางทับบรรทัดของอำเภอนั้นใน PIN_HASH ด้านล่าง
 *   4) ลบ property GEN_PIN ทิ้ง แล้ว Deploy ใหม่
 *************************************************************************************/

/** ====== ตั้งค่า ====== */
var SHEET_ID  = '1ATafnXnhe4NrOrK2e2IPwvyu_yvBBkexASEEhUR9Nss';   // <-- แก้เป็น ID ชีตของคุณ
var DATA_TAB  = 'Data';
var SALT      = 'nbl-influence-2569';            // เกลือผสมรหัส (เปลี่ยนได้ แต่ต้อง re-hash)

/** รายชื่ออำเภอ (ลำดับตามเอกสาร) */
var DISTRICTS = ['เมืองหนองบัวลำภู','ศรีบุญเรือง','นากลาง','โนนสัง','สุวรรณคูหา','นาวัง'];

/** เดือนตามปีงบประมาณ (ตุลาคม=1 ... กันยายน=12) */
var FISCAL_MONTHS = ['ตุลาคม','พฤศจิกายน','ธันวาคม','มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน'];

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
 */
var PIN_HASH = {
  'เมืองหนองบัวลำภู':'99ac1e19fbb4c2314a2ddb84edbcbebd00a2c33d6eec60163c52c5b42e3cdb73',
  'ศรีบุญเรือง'    :'d0cfe74166f6b45d0b3b832eb7cf065fcd5a955797d88a42d66bdc9e401dd8e9',
  'นากลาง'         :'59f72ece39791b9e84ea8459eb09ff24f1be1d4a6329f736e27277f48e7fd967',
  'โนนสัง'         :'62057b4a622861016802b28afd0e36aca90ec1cdf20bdecfce12411e0d0427c7',
  'สุวรรณคูหา'     :'c4eda13d563113d9893427f586ea3bac73de3d9721ee6efd026f78f66ac84b0b',
  'นาวัง'          :'bd3d09d1cda327c2f5fa9feb4e11e76b739652790e0391d08781b8f635b9082c',
  'ADMIN'          :'73076caad34ecb93de40cfc7addab30a5d65a1cd428966c933a3b5a66a7a6043'
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

/** สร้างหัวตาราง + ใส่ข้อมูลตั้งต้นจากแผนปฏิบัติการ — ครบ 12 เดือน ปีงบ 2569 */
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
  var SEED_FY = 2569; // ปีงบของแผนปฏิบัติการนี้ ; ปีถัดไปจะเกิดเองเมื่อมีการกรอกผ่านระบบ
  var now = new Date().toISOString();
  var rows = [];
  // วนทุกเดือน (ตุลาคม=1 ... กันยายน=12) × ทุกอำเภอ = 72 แถว สำหรับปีงบปัจจุบัน
  for (var mo = 1; mo <= 12; mo++){
    DISTRICTS.forEach(function(d){
      var s = seed[d] || {red:0,yellow:0};
      var suppressed = s.red + s.yellow; // ถอดถอน/ปราบปรามแล้วทั้งหมด
      var line = {
        fiscalYear:SEED_FY, month:FISCAL_MONTHS[mo-1], monthOrder:mo, district:d,
        red:s.red, yellow:s.yellow, suppressed:suppressed, remaining:0,
        targetPct:100, resultPct:100,
        complaints:0, patrols:0, operations:0, arrests:0,
        status:'ถอดถอนรายชื่อจากผู้มีอิทธิพลแล้ว', note:'',
        updatedAt:now, updatedBy:'setup'
      };
      rows.push(HEADERS.map(function(h){ return line[h]; }));
    });
  }
  sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  SpreadsheetApp.flush();
  Logger.log('setup เสร็จสิ้น: ใส่ข้อมูล %s แถว (ปีงบ %s × 12 เดือน × %s อำเภอ)', rows.length, SEED_FY, DISTRICTS.length);
}

/** สร้างค่า hash โดยอ่านรหัสจาก Script Properties (รหัสจริงไม่อยู่ในโค้ด)
 *  ตั้ง property GEN_DISTRICT และ GEN_PIN ก่อน แล้วรันฟังก์ชันนี้ ดูผลที่ Logs
 *  เสร็จแล้วควรลบ property GEN_PIN ทิ้งทันที */
function genHash(){
  var props = PropertiesService.getScriptProperties();
  var d = props.getProperty('GEN_DISTRICT');
  var p = props.getProperty('GEN_PIN');
  if (!d || !p){
    Logger.log('โปรดตั้ง Script Property: GEN_DISTRICT (ชื่ออำเภอ/ADMIN) และ GEN_PIN (รหัส) ก่อนรัน');
    return;
  }
  Logger.log("คัดบรรทัดนี้ไปวางใน PIN_HASH:");
  Logger.log("  '%s':'%s',", d, hashOf(d, p));
  Logger.log("** อย่าลืมลบ property GEN_PIN ทิ้งหลังใช้งาน **");
}
