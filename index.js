// index.js (봇 + 일꾼 통합 코드 + 동적 포트)
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const cron = require('node-cron');
const http = require('http'); // ⚠️ [필수] UptimeRobot 핑(Ping)을 받기 위한 모듈

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

// Google Sheets 인증
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_CREDS.client_email,
  key: GOOGLE_SERVICE_ACCOUNT_CREDS.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- 1. '/weather' 명령어 등록 ---
const commands = [
  {
    name: 'weather',
    description: '현재 위치(서울)의 최신 날씨와 행동 지침을 DM으로 받습니다.',
  },
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
  } else { // OnDemand or Worker
    const nextHourDate = new Date(now.getTime() + (60 * 60 * 1000));
    const nextKST = getKSTDate(nextHourDate);
    forecastTime = nextKST.hour.toString().padStart(2, '0') + '00';
    forecastHourForPrompt = `${nextKST.hour}시`;
    forecastDate = nextKST.stringDate;
  }
  
  return { baseDate, baseTime, forecastTime, forecastHourForPrompt, forecastDate };
}

async function
