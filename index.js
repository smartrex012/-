// index.js (봇 + 일꾼 통합 코드 + 최종 정리)
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const cron = require('node-cron');
const http = require('http'); // UptimeRobot 핑을 받기 위한 모듈

// --- 0. 설정 (Render Secrets에서 불러오기) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATA_API_KEY = process.env.DATA_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SUBSCRIBER_SHEET_NAME = "Subscribers";
const FORECAST_SHEET_NAME = "ForecastData";
const META_SHEET_NAME = "Metadata";
const CLIENT_ID = process.env.CLIENT_ID; 
const GOOGLE_SERVICE_ACCOUNT_CREDS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS);

// Google Sheets 인증 및 클라이언트
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_CREDS.client_email,
  key: GOOGLE_SERVICE_ACCOUNT_CREDS.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- 1. '/weather' 명령어 등록 ---
const commands = [
  { name: 'weather', description: '현재 위치(서울)의 최신 날씨와 행동 지침을 DM으로 받습니다.' },
];
const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
(async () => {
  try {
    console.log('(/) 슬래시 명령어 등록 시작...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ 슬래시 명령어 등록 성공!');
  } catch (error) {
    console.error('❌ 명령어 등록 실패:', error);
  }
})();

// --- 2. 봇 로그인 및 명령어 리스너 (빠른 작업) ---
client.once('clientReady', () => { 
  console.log(`✅ ${client.user.tag} 봇이 로그인했습니다.`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand() || interaction.commandName !== 'weather') return;

  await interaction.deferReply({ ephemeral: true }); 

  try {
    const userId = interaction.user.id;
    const userName = interaction.user.username;

    const userLocation = await getUserLocation(userId);
    if (!userLocation) {
      await interaction.editReply("🚨 구독자 목록(`Subscribers` 시트)에 등록되지 않은 사용자입니다.");
      return;
    }

    const times = getApiTime("OnDemand"); 
    const extractedData = await readDataFromSheet(times.forecastTime, times.forecastHourForPrompt, times.forecastDate);
    
    if (!extractedData) {
      await interaction.editReply("🚨 Google Sheet에 아직 데이터가 없거나 읽기에 실패했습니다. (백그라운드 작업이 실행 중일 수 있습니다.)");
      return;
    }
    
    extractedData.locationName = userLocation;
    const finalMessage = await generatePolicyMessage(extractedData);
    await interaction.user.send(finalMessage);
    await interaction.editReply(`✅ ${userName}님의 DM으로 ${extractedData.forecastHour} 날씨 정보를 보냈어요!`);

  } catch (e) {
    console.error("'/weather' 처리 오류:", e);
    await interaction.editReply("🚨 봇 실행 중 오류가 발생했습니다.");
  }
});

// --- 3. '일꾼' 작업 정의 (느린 작업) ---

// 작업 1: 3시간마다 기상청 API 데이터 업데이트
cron.schedule('10 */3 * * *', async () => { 
  console.log("⏰ (일꾼) API 데이터 업데이트를 시작합니다...");
  
  const { baseDate, baseTime } = getApiTime("Worker");
  const isDataFresh = await checkDataFreshness(baseTime);

  if (!isDataFresh) {
    console.log("데이터가 오래되었습니다. 기상청 API에서 새 데이터를 가져옵니다...");
    const updateSuccess = await updateForecastData(baseDate, baseTime);
    if (updateSuccess) {
      await updateMetadata(baseTime);
    }
  } else {
    console.log("데이터가 이미 최신입니다. 업데이트를 건너뜁니다.");
  }
}, {
  timezone: "Asia/Seoul"
});

// 작업 2: 매일 아침 6:50분 공용 채널에 알림
cron.schedule('50 6 * * *', async () => {
  console.log("===== ⏰ (일꾼) 아침 6:50 자동 알림 시작 =====");
  try {
    const kstNow = getKSTDate(new Date());
    const forecastDate = kstNow.stringDate;
    
    const extractedData = await readDataFromSheet("0700", "7시", forecastDate);
    if (!extractedData) {
      console.log("시트 읽기 실패. 공용 알림 중단.");
      return;
    }

    const publicChannels = await readSubscribers("Public");
    if (!publicChannels || publicChannels.length === 0) {
      console.log("공용 알림 채널이 없습니다.");
      return;
    }

    extractedData.locationName = publicChannels[0].locationName; // '서울'
    const finalMessage = await generatePolicyMessage(extractedData);

    for (const channel of publicChannels) {
      await sendChannelMessage(channel.channelId, finalMessage, channel.name);
    }
  } catch (e) {
    console.error("아침 자동 알림 오류:", e);
  }
}, {
  timezone: "Asia/Seoul"
});


// --- 4. 헬퍼 함수들 (GAS 코드 -> Node.js 코드로 변환) ---

function getKSTDate(date) {
  const kst = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  const year = kst.getUTCFullYear();
  const month = (kst.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = kst.getUTCDate().toString().padStart(2, '0');
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  return { stringDate: `${year}${month}${day}`, hour, minute };
}

function getApiTime(mode = "OnDemand") { 
  const now = new Date();
  const { stringDate, hour, minute } = getKSTDate(now);
  
  const 발표시각_리스트 = [2, 5, 8, 11, 14, 17, 20, 23];
  let baseDate = stringDate;
  let baseTime = "";
  let targetHour = -1;
  for (const h of 발표시각_리스트) {
    if (hour < h || (hour === h && minute < 10)) { break; }
    targetHour = h;
  }
  if (targetHour === -1) {
    let yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000));
    baseDate = getKSTDate(yesterday).stringDate;
    baseTime = "2300";
  } else {
    baseTime = targetHour.toString().padStart(2, '0') + '00';
  }
  
  let forecastTime = "", forecastHourForPrompt = "", forecastDate = stringDate;

  if (mode === "Morning") {
    forecastTime = "0700";
    forecastHourForPrompt = "7시";
  } else { // OnDemand
    const nextHourDate = new Date(now.getTime() + (60 * 60 * 1000));
    const nextKST = getKSTDate(nextHourDate);
    forecastTime = nextKST.hour.toString().padStart(2, '0') + '00';
    forecastHourForPrompt = `${nextKST.hour}시`;
    forecastDate = nextKST.stringDate;
  }
  
  return { baseDate, baseTime, forecastTime, forecastHourForPrompt, forecastDate };
}

async function checkDataFreshness(currentBaseTime) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[META_SHEET_NAME];
    if (!sheet) {
        console.log("Metadata 시트가 없습니다. 새로 생성합니다.");
        return false;
    }
    await sheet.loadCells('B1');
    const storedBaseTime = sheet.getCellByA1('B1').value;
    return storedBaseTime == currentBaseTime;
  } catch (e) {
    console.error("메타데이터 확인 오류 (처음 실행일 수 있음):", e.message);
    return false;
  }
}

async function updateMetadata(currentBaseTime) {
  try {
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle[META_SHEET_NAME];
    if (!sheet) {
      sheet = await doc.addSheet({ title: META_SHEET_NAME });
    }
    await sheet.loadCells('A1:B1');
    sheet.getCellByA1('A1').value = "LastUpdateBaseTime";
    sheet.getCellByA1('B1').value = currentBaseTime;
    await sheet.saveUpdatedCells();
  } catch (e) {
    console.error("메타데이터 쓰기 오류:", e.message);
  }
}

async function readDataFromSheet(forecastTime, forecastHourForPrompt, forecastDate) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[FORECAST_SHEET_NAME];
    if (!sheet) throw new Error("ForecastData 시트를 찾을 수 없습니다.");

    await sheet.loadHeaderRow(); 
    const rows = await sheet.getRows(); 

    const extracted = { temp: null, precipProb: null, precipType: null, sky: null, forecastHour: forecastHourForPrompt, tmn: null, tmx: null, tempRange: null, wsd: null, windChill: null };
    let dailyTemps = [];

    for (const row of rows) {
      const date = row.get('fcstDate');
      const time = row.get('fcstTime');
      const category = row.get('category');
      const value = row.get('fcstValue');

      if (date == forecastDate) {
        if (category === "TMP") dailyTemps.push(parseFloat(value));
      }
      
      if (date == forecastDate && time == forecastTime) {
        switch (category) {
          case "TMP": extracted.temp = parseFloat(value); break;
          case "POP": extracted.precipProb = parseInt(value, 10); break;
          case "PTY": extracted.precipType = value; break;
          case "SKY": extracted.sky = value; break;
          case "WSD": extracted.wsd = parseFloat(value); break; 
        }
      }
    }
    
    if (extracted.temp === null) { throw new Error(`Sheet에서 ${forecastTime}시 예보 데이터를 찾을 수 없습니다.`); }
    if (dailyTemps.length > 0) {
      extracted.tmx = Math.max(...dailyTemps);
      extracted.tmn = Math.min(...dailyTemps);
      extracted.tempRange = extracted.tmx - extracted.tmn;
    }
    if (extracted.temp !== null && extracted.wsd !== null) {
      const T = extracted.temp, V_kmh = extracted.wsd * 3.6; 
      if (T <= 10 && V_kmh >= 4.8) {
        const V16 = Math.pow(V_kmh, 0.16);
        extracted.windChill = (13.12 + (0.6215 * T) - (11.37 * V16) + (0.3965 * T * V16)).toFixed(1);
      }
    }
    console.log("Google Sheet에서 데이터 읽기 성공!");
    return extracted;
  } catch (e) {
    console.error("Google Sheet 읽기 오류:", e);
    return null;
  }
}

async function updateForecastData(baseDate, baseTime) {
  const encodedKey = encodeURIComponent(DATA_API_KEY);
  const NX_COORD = 60, NY_COORD = 127; // 서울 기준
  const apiUrl = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=${encodedKey}` +
                 `&base_date=${baseDate}&base_time=${baseTime}&nx=${NX_COORD}&ny=${NY_COORD}` +
                 `&dataType=JSON&numOfRows=300&pageNo=1`; 
  
  for (let i = 0; i < 10; i++) {
    try {
      console.log(`API 데이터 업데이트 시도 (${i + 1}/10)...`);
      const response = await axios.get(apiUrl, { timeout: 300000 }); // 5분 타임아웃
      const dataObject = response.data;

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
      let sheet = doc.sheetsByTitle[FORECAST_SHEET_NAME];
      if (!sheet) {
        sheet = await doc.addSheet({ title: FORECAST_SHEET_NAME, headerValues: ['fcstDate', 'fcstTime', 'category', 'fcstValue'] });
      } else {
         await sheet.clear(); 
         await sheet.setHeaderRow(['fcstDate', 'fcstTime', 'category', 'fcstValue']);
      }
      await sheet.addRows(dataToSave); 

      console.log(`✅ 데이터 업데이트 성공! ${dataToSave.length}개 행이 저장되었습니다.`);
      return true; // 성공
    } catch (e) {
      console.error(`시도 ${i + 1} 실패:`, e.message);
      if (i < 9) {
        console.log("10초 후 재시도합니다...");
        await new Promise(resolve => setTimeout(resolve, 10000)); 
      }
    }
  }
  console.log("API 호출에 최종 실패했습니다.");
  return false; // 실패
}

async function generatePolicyMessage(data) {
  const skyText = (data.sky === '1') ? '맑음' : (data.sky === '3') ? '구름많음' : '흐림';
  const precipText = (data.precipType === '0') ? '없음' : (data.precipType === '1') ? '비' : (data.precipType === '2') ? '비/눈' : (data.precipType === '3') ? '소나기' : '알 수 없음';
  let tempRangeText = "", windChillText = "";
  if (data.tempRange !== null) tempRangeText = `(오늘 일교차: ${data.tempRange.toFixed(1)}℃)`;
  if (data.windChill !== null) windChillText = `(체감 온도: ${data.windChill}℃)`;
  
  const prompt = `
    당신은 날씨 데이터를 분석해 "그래서 뭘 해야 하는지"만 알려주는 '날씨 알리미'입니다. 어투는 '방금 막 기상한 이들이 기분 좋게 받아들일 수 있는 정도'로 해주세요. 
    [예보 데이터]
    - 위치: ${data.locationName}
    - 시간: ${data.forecastHour}
    - 현재 기온: ${data.temp}℃
    - 하늘 상태: ${skyText}
    - 강수 형태: ${precipText}
    - 강수 확률: ${data.precipProb}%
    - ${tempRangeText}
    - ${windChillText}
    규칙:
    1. ${data.locationName}의 사용자가 ${data.forecastHour}에 참고해야 할 구체적인 행동 지침(우산, 활동)과 옷차림(상의/하의)을 먼저 제시하세요.
    2. [체감온도/일교차 반영] '체감 온도'나 '일교차' 정보가 있다면, 옷차림 추천 시 (예: "바람이 불어 체감온도가 낮으니 따뜻하게 입으세요", "일교차가 크니 겉옷을 챙기세요") 꼭 반영하세요.
    3. [옷차림 이모지] 옷차림 추천 시 🧥, 👕, 👖 같은 이모지를 사용하세요.
    4. [날씨 설명] 행동 지침 제시 후, 한 줄 띄우고 ${data.locationName}의 날씨 요약을 간략히 설명하세요.
    5. [날씨 이모지] 날씨 요약 끝에 날씨를 표현하는 ☀️, ☁️, 🌧️ 같은 이모지 1개를 붙여주세요.
  `;
  
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
  
  try {
    const response = await axios.post(GEMINI_URL, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 1024 }
    });
    
    return response.data.candidates[0].content.parts[0].text.trim();
  } catch (e) {
    console.error("Gemini API 호출 오류:", e.response ? e.response.data : e.message);
    return "🚨 AI가 행동 지침 생성에 실패했습니다.";
  }
}

async function getUserLocation(userId) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
    await sheet.loadHeaderRow(); 
    const rows = await sheet.getRows();
    const user = rows.find(row => row.get('Type') === 'Private' && row.get('ID') == userId);
    return user ? user.get('LocationName') : null;
  } catch (e) {
    console.error("구독자 시트(UserID) 읽기 오류:", e);
    return null;
  }
}

async function readSubscribers(type) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    
    const subscribers = [];
    for (const row of rows) {
      const rowType = row.get('Type');
      const id = row.get('ID');
      const locationName = row.get('LocationName');

      if (type === "Public" && rowType === "Public" && id) {
        subscribers.push({ name: `Channel-${id}`, channelId: id, locationName: locationName });
      }
    }
    return subscribers;
  } catch (e) {
    console.error("구독자 시트(Public) 읽기 오류:", e);
    return null;
  }
}

async function sendChannelMessage(channelId, messageText, channelName) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel) {
      await channel.send(messageText);
      console.log(`[${channelName}] 채널에 메시지 전송 성공.`);
    } else {
      console.log(`[${channelName}] 채널을 찾을 수 없습니다.`);
    }
  } catch (e) {
    console.error(`[${channelName}] 채널 전송 실패:`, e);
  }
}

// --- 5. ⚠️ [수정] UptimeRobot 핑(Ping)을 받기 위한 웹 서버 ---
// Render가 10000번 포트를 열도록 명시적으로 지시합니다.
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Discord bot is alive and listening for pings!');
}).listen(10000, () => {
  console.log('UptimeRobot 리스너가 포트 10000에서 실행 중입니다.');
});

client.login(BOT_TOKEN);
