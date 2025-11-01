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


// =========================================================================
async function readDataFromSheet(forecastTime, forecastHourForPrompt, forecastDate) {
  try {
    await doc.loadInfo(); // ⚠️ [수정] 403 오류 해결을 위해 loadInfo() 다시 추가
    const sheet = doc.sheetsByTitle[FORECAST_SHEET_NAME];
    if (!sheet) throw new Error("ForecastData 시트를 찾을 수 없습니다.");

    await sheet.loadHeaderRow(); 
    const rows = await sheet.getRows(); 

    const extracted = { temp: null, precipProb: null, precipType: null, sky: null, forecastHour: forecastHourForPrompt, tmn: null, tmx: null, tempRange: null, wsd: null, windChill: null };
    let dailyTemps = [];

    // ⚠️ [수정] "0600"(String)을 600(Number)으로 변환하여 비교 준비
    const targetTimeNumber = parseInt(forecastTime, 10); 

    for (const row of rows) {
      // (시트 열 순서: [0]fcstDate, [1]fcstTime, [2]category, [3]fcstValue)
      // ⚠️ row.get('fcstTime')은 Google Sheet에서 600 (Number)으로 읽어옵니다.
      const date = row.get('fcstDate');
      const time = row.get('fcstTime'); // 이것은 숫자(Number) 600입니다.
      const category = row.get('category');
      const value = row.get('fcstValue');

      if (date == forecastDate) {
        if (category === "TMP") dailyTemps.push(parseFloat(value));
      }
      
      // ⚠️ [수정] 숫자(time)와 숫자(targetTimeNumber)를 비교
      if (date == forecastDate && time == targetTimeNumber) { 
        switch (category) {
          case "TMP": extracted.temp = parseFloat(value); break;
          case "POP": extracted.precipProb = parseInt(value, 10); break;
          case "PTY": extracted.precipType = value; break;
          case "SKY": extracted.sky = value; break;
          case "WSD": extracted.wsd = parseFloat(value); break; 
        }
      }
    }
    
    if (extracted.temp === null) { 
      // [수정] 로그에 숫자 비교가 보이도록 추가
      throw new Error(`Sheet에서 ${forecastTime}시(숫자: ${targetTimeNumber}) 예보 데이터를 찾을 수 없습니다.`); 
    }
    
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
    
    if (extracted.temp === null) { 
      // [수정] 로그에 숫자 비교가 보이도록 추가
      throw new Error(`Sheet에서 ${forecastTime}시(숫자: ${targetTimeNumber}) 예보 데이터를 찾을 수 없습니다.`); 
    }
    
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
  
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  
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
    // (doc.loadInfo()는 봇 시작 시 1회만 실행)
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
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
    // (doc.loadInfo()는 봇 시작 시 1회만 실행)
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

// --- 5. ⚠️ [필수] UptimeRobot 핑(Ping)을 받기 위한 웹 서버 ---
const PORT = process.env.PORT || 10000; // Render가 할당하는 동적 포트 사용
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Discord bot is alive and listening for pings!');
}).listen(PORT, () => {
  console.log(`UptimeRobot 리스너가 포트 ${PORT}에서 실행 중입니다.`);
});

client.login(BOT_TOKEN);
