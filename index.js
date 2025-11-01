// index.js (봇 + 일꾼 통합 코드)
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const cron = require('node-cron');
// ⚠️ [수정] const http = require('http'); <-- 이 줄을 삭제했습니다.

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
    console.error("'/weather' 처리
