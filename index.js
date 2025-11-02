// index.js (봇 + 일꾼 통합 코드)
const { Client, GatewayIntentBits, REST, Routes, Events } = require('discord.js'); // Events 추가
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const cron = require('node-cron');
const http = require('http'); // ⚠️ [필수] UptimeRobot 핑(Ping)을 받기 위한 모듈

// --- 0. 설정 (Render Secrets에서 불러오기) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// ⚠️ DATA_API_KEY는 '일꾼'(GAS)이 관리하므로 여기서는 필요 없습니다.
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SUBSCRIBER_SHEET_NAME = "Subscribers";
const FORECAST_SHEET_NAME = "ForecastData";
const CLIENT_ID = process.env.CLIENT_ID; // ⚠️ Secrets에 봇의 Application ID 저장 필수
const TEST_GUILD_ID = process.env.TEST_GUILD_ID; // ⚠️ [권장] Secrets에 '서버 ID'를 이 이름으로 저장하세요.
const GOOGLE_SERVICE_ACCOUNT_CREDS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS);

// Google Sheets 인증
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_CREDS.client_email,
  key: GOOGLE_SERVICE_ACCOUNT_CREDS.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 🟡 [수정] 봇 시작 시 1회만 시트 정보 로드 (효율화)
(async () => {
  try {
    await doc.loadInfo();
    console.log('✅ Google Spreadsheet 메타데이터 로드 완료!');
  } catch (e) {
    console.error("❌ Google Sheet 메타데이터 로드 실패:", e);
  }
})();

// --- 1. '/weather' 명령어 등록 (즉시 등록되는 '길드' 방식) ---
const commands = [
  { name: 'weather', description: '현재 위치(서울)의 최신 날씨와 행동 지침을 DM으로 받습니다.' },
];
const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
(async () => {
  try {
    console.log('(/) 슬래시 명령어 등록 시작...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, TEST_GUILD_ID), // 👈 '길드' 명령어로 즉시 등록
      { body: commands }
    );
    console.log('✅ 슬래시 명령어 (길드) 등록 성공!');
  } catch (error) {
    console.error('❌ 명령어 등록 실패:', error);
  }
})();

// --- 2. 봇 로그인 및 명령어 리스너 (빠른 작업) ---
client.once('clientReady', () => { 
  console.log(`✅ ${client.user.tag} 봇이 로그인했습니다.`);
});

client.on(Events.InteractionCreate, async interaction => {
  // ⚠️ [수정] 'isCommand' -> 'isChatInputCommand'
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'weather') return;

  // ⚠️ [수정] 'ephemeral: true' -> 'flags: 64'로 변경 (경고 해결)
  await interaction.deferReply({ flags: 64 }); // 64 = 나에게만 보이는 로딩

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
      await interaction.editReply("🚨 Google Sheet에 아직 데이터가 없거나 읽기에 실패했습니다. (백그라운드 '일꾼'이 아직 데이터를 저장하지 못했습니다.)");
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

// --- 3. 아침 6:50 자동 알림 (node-cron 사용) ---
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
  const kstNow = getKSTDate(now);
  const hour = kstNow.hour;
  const minute = kstNow.minute;
  let baseDate = kstNow.stringDate;
  
  const 발표시각_리스트 = [2, 5, 8, 11, 14, 17, 20, 23];
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
  
  let forecastTime = "";
  let forecastHourForPrompt = "";
  let forecastDate = kstNow.stringDate;

  // ⚠️ [수정] 'OnDemand' 로직을 3시간 단위로 변경
  if (mode === "Morning" && hour >= 6 && hour < 7) { 
    forecastTime = "0700";
    forecastHourForPrompt = "7시";
  } else { // OnDemand or Worker
    // 현재 시간(hour) 이후의 가장 가까운 3시간 단위 예보 시간을 찾음
    const availableTimes = [0, 3, 6, 9, 12, 15, 18, 21];
    let nextForecastHour = availableTimes.find(h => h > hour);
    
    if (!nextForecastHour) { // 21시 이후면 다음날 00시
      nextForecastHour = 0;
      let tomorrow = new Date(now.getTime() + (24 * 60 * 60 * 1000));
      forecastDate = getKSTDate(tomorrow).stringDate;
    }
    
    forecastTime = nextForecastHour.toString().padStart(2, '0') + '00';
    forecastHourForPrompt = `${nextForecastHour}시`;
  }
  
  return { baseDate, baseTime, forecastTime, forecastHourForPrompt, forecastDate };
}


async function readDataFromSheet(forecastTime, forecastHourForPrompt, forecastDate) {
  try { 
    await doc.loadInfo(); 
    const sheet = doc.sheetsByTitle[FORECAST_SHEET_NAME];
    if (!sheet) throw new Error("ForecastData 시트를 찾을 수 없습니다.");

    // ⚠️ [수정] getRows() 대신 loadCells()를 사용합니다.
    // 1행(헤더)은 건너뛰고, 2행(index 1)부터 A:D 열의 데이터만 로드합니다.
    console.log("시트 셀 데이터 로드를 시작합니다...");
    // A2:D(sheet.rowCount) 범위의 셀을 로드합니다.
    await sheet.loadCells({
        "startRowIndex": 1, // 2행부터 (0-based index)
        "endRowIndex": sheet.rowCount, // 시트의 마지막 행까지
        "startColumnIndex": 0, // A열부터
        "endColumnIndex": 4 // D열까지
    });
    console.log(`총 ${sheet.rowCount - 1}개의 행 셀 데이터를 로드했습니다.`);

    const extracted = { temp: null, precipProb: null, precipType: null, sky: null, forecastHour: forecastHourForPrompt, tmn: null, tmx: null, tempRange: null, wsd: null, windChill: null };
    let dailyTemps = [];

    console.log(`[목표] 날짜: "${forecastDate}", 시간: "${forecastTime}"`);
    let foundMatch = false; 

    // ⚠️ [수정] for...of rows 대신, for 루프를 사용해 셀을 직접 순회합니다.
    // loadCells()는 0-based index를 쓰므로, r=1이 시트의 '2행'을 의미합니다.
    for (let r = 1; r < sheet.rowCount; r++) {
        // .getCell(rowIndex, colIndex)로 셀 객체를 가져옵니다.
        const dateCell = sheet.getCell(r, 0);      // (r행, A열)
        const timeCell = sheet.getCell(r, 1);      // (r행, B열)
        const categoryCell = sheet.getCell(r, 2);  // (r행, C열)
        const valueCell = sheet.getCell(r, 3);     // (r행, D열)

      // ⚠️ [수정] .get() 대신 .value 속성을 사용합니다.
      const date = dateCell.value;
      const time = timeCell.value;
      const category = categoryCell.value;
      const value = valueCell.value;

      // (이하 데이터 처리 로직은 동일)
      const dateFromSheet = (date ?? "").toString().replace(/,/g, '').trim();
      const timeFromSheet = (time ?? "").toString().replace(/,/g, '').trim();

      if (dateFromSheet == forecastDate) {
        if (category === "TMP") dailyTemps.push(parseFloat(value));
        
        if (timeFromSheet == forecastTime) {
            foundMatch = true; 
            switch (category) {
              case "TMP": extracted.temp = parseFloat(value); break;
              case "POP": extracted.precipProb = parseInt(value, 10); break;
              case "PTY": extracted.precipType = value; break;
              case "SKY": extracted.sky = value; break;
              case "WSD": extracted.wsd = parseFloat(value); break; 
            }
        }
      }
    } // for 루프 끝

    // --- 디버깅 로그 ---
    if (foundMatch) {
        console.log(`[성공] "${forecastTime}"시 데이터를 찾았습니다.`);
    } else {
        console.log(`[실패] "${forecastTime}"시 데이터를 찾지 못했습니다.`);
        
        if (sheet.rowCount > 1) {
            // 샘플을 마지막 행(r = sheet.rowCount - 1)에서 가져옵니다.
            const sampleDateRaw = sheet.getCell(sheet.rowCount - 1, 0).value;
            const sampleTimeRaw = sheet.getCell(sheet.rowCount - 1, 1).value;
            console.log(`[샘플] 원본 Date: "${sampleDateRaw}" (Type: ${typeof sampleDateRaw})`);
            console.log(`[샘플] 원본 Time: "${sampleTimeRaw}" (Type: ${typeof sampleTimeRaw})`);
            
            const sampleDateProcessed = (sampleDateRaw ?? "").toString().replace(/,/g, '').trim();
            const sampleTimeProcessed = (sampleTimeRaw ?? "").toString().replace(/,/g, '').trim();
            console.log(`[샘플] 처리된 Date: "${sampleDateProcessed}"`);
            console.log(`[샘플] 처리된 Time: "${sampleTimeProcessed}"`);
        }
    }
    // --- 디버깅 로그 끝 ---
    
    if (extracted.temp === null) { 
      throw new Error(`Sheet에서 ${forecastDate} / ${forecastTime}시 예보 데이터를 찾을 수 없습니다.`); 
    }
    
    // --- 기존 데이터 처리 로직 ---
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
} // 함수 끝

async function generatePolicyMessage(data) {
  const skyText = (data.sky === '1') ? '맑음' : (data.sky === '3') ? '구름많음' : '흐림';

  // ⚠️ [수정] 기상청 API 명세서에 따라 PTY 코드를 수정합니다. (3: 눈, 4: 소나기 등)
  const precipText = (data.precipType === '0') ? '없음' : (data.precipType === '1') ? '비' : (data.precipType === '2') ? '비/눈' : (data.precipType === '3') ? '눈' : (data.precipType === '4') ? '소나기' : (data.precipType === '5') ? '빗방울' : (data.precipType === '6') ? '빗방울/눈날림' : (data.precipType === '7') ? '눈날림' : '알 수 없음';
  
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
  
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  try {
    const response = await axios.post(GEMINI_URL, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 4096}
    });
    
    // ⚠️ [수정] API 응답에 'candidates'가 있는지, 비어있지 않은지 확인합니다.
    if (response.data && response.data.candidates && response.data.candidates.length > 0) {
      // ⚠️ [수정] content.parts가 있는지도 확인합니다.
      const parts = response.data.candidates[0].content.parts;
      if (parts && parts.length > 0) {
        return parts[0].text.trim();
      }
    }
    
    // ⚠️ [수정] candidates가 없거나 비어있는 경우 (예: 세이프티 설정 차단)
    console.error("Gemini API 호출은 성공했으나, 유효한 'candidates'가 없습니다.");
    // 봇이 차단된 이유(예: "blockReason": "SAFETY")를 확인하기 위해 전체 응답을 로깅합니다.
    console.log("전체 API 응답:", JSON.stringify(response.data, null, 2));
    return "🚨 AI가 행동 지침 생성에 실패했습니다. (API 응답 없음)";

  } catch (e) {
    // ⚠️ [수정] e.response가 있는 경우(axios 오류)와 없는 경우(일반 JS 오류)를 구분하여 로깅합니다.
    if (e.response) {
      // 4xx, 5xx 응답 등 axios 오류
      console.error("Gemini API 호출 실패 (HTTP 오류):", e.response.status, e.response.data);
    } else {
      // 'candidates[0]' 접근 오류 등 코드 내 JS 오류
      console.error("Gemini API 응답 처리 오류:", e.message);
    }
    return "🚨 AI가 행동 지침 생성에 실패했습니다.";
  }
}

async function getUserLocation(userId) {
  try {
    await doc.loadInfo(); // ⚠️ [필수 추가] 시트 접근 전 loadInfo() 호출
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
    if (!sheet) throw new Error("Subscribers 시트를 찾을 수 없습니다."); // 방어 코드

    await sheet.loadHeaderRow(); 
    const rows = await sheet.getRows();
    const user = rows.find(row => row.get('Type') === 'Private' && row.get('ID').toString() == userId.toString());
    return user ? user.get('LocationName') : null;
  } catch (e) {
    console.error("구독자 시트(UserID) 읽기 오류:", e);
    return null;
  }
}

async function readSubscribers(type) {
  try {
    await doc.loadInfo(); // ⚠️ [필수 추가] 시트 접근 전 loadInfo() 호출
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
    if (!sheet) throw new Error("Subscribers 시트를 찾을 수 없습니다."); // 방어 코드

    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
// ... (이하 동일) ...
    
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

// --- 5. ⚠️ [필수] UptimeRobot 핑(Ping)을 받기 위한 웹 서버 ---
const PORT = process.env.PORT || 10000; // Render가 할당하는 동적 포트 사용
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Discord bot is alive and listening for pings!');
}).listen(PORT, () => {
  console.log(`UptimeRobot 리스너가 포트 ${PORT}에서 실행 중입니다.`);
});

client.login(BOT_TOKEN);
