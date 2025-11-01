// updateSheet.js (느린 '일꾼'용 코드)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const cron = require('node-cron');

// --- 0. 설정 ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DATA_API_KEY = process.env.DATA_API_KEY;
const FORECAST_SHEET_NAME = "ForecastData";
const META_SHEET_NAME = "Metadata";
const GOOGLE_SERVICE_ACCOUNT_CREDS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS);

const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_CREDS.client_email,
  key: GOOGLE_SERVICE_ACCOUNT_CREDS.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// --- 1. 3시간마다 실행 (GAS 트리거 대체) ---
// (매 3시간 10분에 실행. 예: 02:10, 05:10, 08:10 ...)
console.log("🔄 '일꾼'이 시작되었습니다. 3시간마다 API를 업데이트합니다.");
cron.schedule('10 */3 * * *', () => {
  console.log("⏰ API 데이터 업데이트를 시작합니다...");
  updateForecastData();
}, {
  timezone: "Asia/Seoul"
});

// --- 2. API 시간 계산 ---
function getApiTime() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  
  const baseHour = kst.getUTCHours();
  const currentMinute = kst.getUTCMinutes();
  let baseDate = `${kst.getUTCFullYear()}${(kst.getUTCMonth() + 1).toString().padStart(2, '0')}${kst.getUTCDate().toString().padStart(2, '0')}`;
  
  const 발표시각_리스트 = [2, 5, 8, 11, 14, 17, 20, 23];
  let baseTime = "";
  let targetHour = -1;

  for (const h of 발표시각_리스트) {
    if (baseHour < h || (baseHour === h && currentMinute < 10)) { break; }
    targetHour = h;
  }

  if (targetHour === -1) {
    let yesterday = new Date(kst.getTime() - (24 * 60 * 60 * 1000));
    baseDate = `${yesterday.getUTCFullYear()}${(yesterday.getUTCMonth() + 1).toString().padStart(2, '0')}${yesterday.getUTCDate().toString().padStart(2, '0')}`;
    baseTime = "2300";
  } else {
    baseTime = targetHour.toString().padStart(2, '0') + '00';
  }
  return { baseDate, baseTime };
}

// --- 3. 기상청 API 호출 및 시트 저장 ---
async function updateForecastData() {
  const { baseDate, baseTime } = getApiTime(); 
  const encodedKey = encodeURIComponent(DATA_API_KEY);
  const NX_COORD = 60, NY_COORD = 127; // 서울 기준
  
  const apiUrl = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=${encodedKey}` +
                 `&base_date=${baseDate}&base_time=${baseTime}&nx=${NX_COORD}&ny=${NY_COORD}` +
                 `&dataType=JSON&numOfRows=300&pageNo=1`; 

  // (재시도 로직은 Node.js에서 더 간단하게 구현 가능하나, GAS 버전 유지)
  for (let i = 0; i < 10; i++) {
    try {
      console.log(`API 데이터 업데이트 시도 (${i + 1}/10)...`);
      const response = await axios.get(apiUrl, { timeout: 300000 }); // 5분 타임아웃
      
      const dataObject = response.data; // axios는 JSON을 자동으로 파싱함

      if (dataObject.response.header.resultCode !== "00") {
        throw new Error(`API가 오류를 반환했습니다: ${dataObject.response.header.resultMsg}`);
      }

      const items = dataObject.response.body.items.item; 
      if (!items) throw new Error("API 응답에 유효한 데이터 항목이 없습니다.");
      
      const dataToSave = items.map(item => ({
        fcstDate: item.fcstDate, 
        fcstTime: item.fcstTime,
        category: item.category,
        fcstValue: item.fcstValue
      }));

      await doc.loadInfo();
      const sheet = doc.sheetsByTitle[FORECAST_SHEET_NAME];
      await sheet.clear(); 
      await sheet.setHeaderRow(['fcstDate', 'fcstTime', 'category', 'fcstValue']);
      await sheet.addRows(dataToSave); 

      const metaSheet = doc.sheetsByTitle[META_SHEET_NAME];
      await metaSheet.loadCells('A1:B1');
      const cellA1 = metaSheet.getCellByA1('A1');
      const cellB1 = metaSheet.getCellByA1('B1');
      cellA1.value = "LastUpdateBaseTime";
      cellB1.value = baseTime;
      await metaSheet.saveUpdatedCells();

      console.log(`✅ 데이터 업데이트 성공! ${dataToSave.length}개 행이 저장되었습니다.`);
      return true; // 성공

    } catch (e) {
      console.error(`시도 ${i + 1} 실패:`, e.message);
      if (i < 9) { 
        console.log("10초 후 재시도합니다...");
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10초 대기
      }
    }
  }
  console.log("API 호출에 최종 실패했습니다.");
  return false; // 실패
}
