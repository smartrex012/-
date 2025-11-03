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

// ⚠️ [수정] GuildMembers 인텐트를 추가합니다.
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers // 👈 [추가]
  ] 
});

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
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'weather') return;

  await interaction.deferReply({ flags: 64 }); 

  try {
    const userId = interaction.user.id;
    const userName = interaction.user.username;

    const userInfo = await getUserInfo(userId); // ⚠️ [수정] getUserInfo 호출
    if (!userInfo || !userInfo.nx || !userInfo.ny) { // ⚠️ [수정] nx, ny 확인
      await interaction.editReply("🚨 구독자 목록(`Subscribers` 시트)에 등록되지 않았거나, 위치(NX/NY) 정보가 없습니다. (Google Form으로 등록했는지 확인하세요)");
      return;
    }

    const times = getApiTime("OnDemand"); 
    // ⚠️ [수정] readDataFromSheet에 userInfo.nx, userInfo.ny 전달
    const extractedData = await readDataFromSheet(times.forecastTime, times.forecastHourForPrompt, times.forecastDate, userInfo.nx, userInfo.ny);
    
    if (!extractedData) {
      await interaction.editReply("🚨 Google Sheet에 아직 데이터가 없거나 읽기에 실패했습니다. (백그라운드 '일꾼'이 아직 데이터를 저장하지 못했거나, 해당 지역 데이터가 없습니다.)");
      return;
    }
    
    extractedData.locationName = userInfo.locationName; // ⚠️ [수정] userInfo에서 이름 사용
    const finalMessage = await generatePolicyMessage(extractedData);
    await interaction.user.send(finalMessage);
    await interaction.editReply(`✅ ${userName}님의 DM으로 [${userInfo.locationName}] 날씨 정보를 보냈어요!`);

  } catch (e) {
    console.error("'/weather' 처리 오류:", e);
    // 봇이 응답하기 전에 죽는 것을 방지
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply("🚨 봇 실행 중 오류가 발생했습니다.");
    } else {
        await interaction.reply({ content: "🚨 봇 실행 중 오류가 발생했습니다.", ephemeral: true });
    }
  }
});

// [ 📄 index.js ]

// --- 3. 아침 6:50 자동 알림 (node-cron 사용) ---
cron.schedule('50 6 * * *', async () => {
  console.log("===== ⏰ (일꾼) 아침 6:50 자동 알림 시작 =====");
  try {
    const kstNow = getKSTDate(new Date());
    const forecastDate = kstNow.stringDate;
    
    // ⚠️ [수정] 'Public' 타입의 모든 구독자 (채널ID, 위치, NX, NY) 목록을 가져옵니다.
    const publicChannels = await readSubscribers("Public");
    if (!publicChannels || publicChannels.length === 0) {
      console.log("공용 알림 채널이 없습니다.");
      return;
    }

    console.log(`총 ${publicChannels.length}개의 공용 채널에 알림을 보냅니다.`);

    // ⚠️ [수정] 각 채널별로 순회하며, 해당 위치의 날씨를 가져와 전송합니다.
    for (const channel of publicChannels) {
      try {
        console.log(`채널 [${channel.name}]의 날씨(${channel.locationName}, ${channel.nx}, ${channel.ny})를 가져옵니다...`);
        // 7시 예보를, 해당 채널의 NX/NY로 조회
        const extractedData = await readDataFromSheet("0700", "7시", forecastDate, channel.nx, channel.ny);
    
        if (!extractedData) {
          console.log(`[${channel.name}] 시트 읽기 실패. 이 채널은 건너뜁니다.`);
          continue; // 다음 채널로 이동
        }

        extractedData.locationName = channel.locationName; // 채널에 등록된 위치 이름 사용
        const finalMessage = await generatePolicyMessage(extractedData);

        await sendChannelMessage(channel.channelId, finalMessage, channel.name);
      } catch (e) {
        console.error(`채널 [${channel.name}] 처리 중 오류 발생:`, e);
      }
    } // for 루프 끝

  } catch (e) {
    console.error("아침 자동 알림 전체 오류:", e);
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
// [ 📄 index.js ]

// [ 📄 index.js ]

// =========================================================================
// (NEW) 새 멤버 서버 입장 시 환영 DM 발송 및 시트 자동 등록
// =========================================================================
client.on(Events.GuildMemberAdd, async member => {
  console.log(`새로운 멤버가 서버에 참여했습니다: ${member.user.tag} (ID: ${member.id})`);

  // 1. (NEW) Subscribers 시트에 사용자 미리 등록
  try {
    await preRegisterUser(member);
    console.log(`${member.user.tag}님을 Subscribers 시트에 미리 등록했습니다.`);
  } catch (e) {
    console.error(`${member.user.tag}님을 시트에 미리 등록하는 데 실패했습니다:`, e);
    // (실패해도 DM은 보내도록 계속 진행)
  }

  // 2. 환영 DM 발송
  // ⚠️ (필수) 여기에 본인의 Google Form URL을 입력하세요.
  const GOOGLE_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSfSvSOHML7KNSdXei3oIDilAyTDSaxwO2SieGw322JnCsrA3Q/viewform?usp=dialog"; 

  const welcomeMessage = `
안녕하세요, ${member.user.username}님! 🌦️ 날씨 알리미 봇 서버에 오신 것을 환영합니다.

봇을 이용하시려면, 먼저 아래 2단계를 완료해 주세요.

**[ 1단계: 본인의 Discord ID 복사하기 ]**
\`${member.id}\`
(방금 입장하신 ${member.user.username}님의 고유 ID입니다. 위 ID를 터치(클릭)하면 복사됩니다.)

**[ 2단계: 위치 등록하기 (필수) ]**
아래 Google Form 링크를 열고, 방금 복사한 **Discord ID**와 **'날씨를 받을 동네 이름'**을 입력해 주세요.
(정확한 '동' 이름 (예: 회기동)을 입력하시면 가장 정확한 예보를 받으실 수 있습니다.)
> ${GOOGLE_FORM_URL}

등록이 완료되면, \`/weather\` 명령어를 사용하실 수 있습니다. 
이 명령어를 사용하면, DM으로 신청하신 위치의 날씨와 행동지침을 받아보실 수 있습니다.
`;

  // 봇이 멤버에게 DM을 보냅니다.
  try {
      await member.send(welcomeMessage);
      console.log(`${member.user.tag}님에게 환영 DM을 보냈습니다.`);
  } catch (e) {
      console.error(`${member.user.tag}님에게 DM을 보내는 데 실패했습니다. (DM이 차단되었을 수 있습니다)`);
  }
});

/**
 * (NEW) 새 멤버를 Subscribers 시트에 미리 등록하는 함수
 */
async function preRegisterUser(member) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
    if (!sheet) throw new Error("Subscribers 시트를 찾을 수 없습니다.");

    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    
    // 이미 등록된 사용자인지 확인 (나갔다가 다시 들어온 경우)
    const existingUser = rows.find(row => row.get('ID').toString() === member.id.toString());

    if (!existingUser) {
      // ⚠️ [수정] LocationName에는 사용자의 현재 닉네임을, NX/NY는 비워둔 채로 추가
      await sheet.addRow({
        Type: "Private",
        ID: member.id,
        LocationName: member.displayName, // 닉네임 저장
        NX: "", // 비워둠
        NY: ""  // 비워둠
      });
    } else {
      console.log(`(사용자 ${member.user.tag}는 이미 등록되어 있습니다. pre-register를 건너뜁니다.)`);
    }
  } catch (e) {
    // 봇 실행이 멈추지 않도록 오류를 잡아서 로깅만 함
    console.error(`preRegisterUser 함수 오류:`, e);
  }
}

// [ 📄 index.js ]

function getApiTime(mode = "OnDemand") { 
  const now = new Date();
  const kstNow = getKSTDate(now);
  const hour = kstNow.hour;
  // ⚠️ [삭제] minute 변수 불필요
 // const minute = kstNow.minute; 
  let baseDate = kstNow.stringDate;
  
  const 발표시각_리스트 = [2, 5, 8, 11, 14, 17, 20, 23];
  let baseTime = "";
  let targetHour = -1;

  // ⚠️ [수정] 10분 딜레이 로직 (minute < 10)을 완전히 제거
  for (const h of 발표시각_리스트) {
    if (hour < h) { break; } 
    targetHour = h;
  }

  if (targetHour === -1) { // 00:00 ~ 01:59 사이
    let yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000));
    baseDate = getKSTDate(yesterday).stringDate;
    baseTime = "2300";
  } else {
    baseTime = targetHour.toString().padStart(2, '0') + '00';
  }
  
  // --- (이하 OnDemand/Morning 로직은 동일) ---
  let forecastTime = "";
  let forecastHourForPrompt = "";
  let forecastDate = kstNow.stringDate;

  if (mode === "Morning" && hour >= 6 && hour < 7) { 
    forecastTime = "0700";
    forecastHourForPrompt = "7시";
  } else { // OnDemand or Worker
    const availableTimes = [0, 3, 6, 9, 12, 15, 18, 21];
    let nextForecastHour = availableTimes.find(h => h > hour);
    
    if (!nextForecastHour) { 
      nextForecastHour = 0;
      let tomorrow = new Date(now.getTime() + (24 * 60 * 60 * 1000));
      forecastDate = getKSTDate(tomorrow).stringDate;
    }
    
    forecastTime = nextForecastHour.toString().padStart(2, '0') + '00';
    forecastHourForPrompt = `${nextForecastHour}시`;
  }
  
  return { baseDate, baseTime, forecastTime, forecastHourForPrompt, forecastDate };
}

// [ 📄 index.js ]

async function readDataFromSheet(forecastTime, forecastHourForPrompt, forecastDate, userNx, userNy) {
  try { 
    await doc.loadInfo(); 
    const sheet = doc.sheetsByTitle[FORECAST_SHEET_NAME];
    if (!sheet) throw new Error("ForecastData 시트를 찾을 수 없습니다.");

    if (sheet.rowCount <= 1) { 
        console.log("ForecastData 시트에 데이터가 없습니다.");
        return null;
    }

    // A2:F(마지막행) 범위의 셀을 로드합니다.
    console.log("시트 셀 데이터 로드를 시작합니다...");
    await sheet.loadCells(`A2:F${sheet.rowCount}`); 

    const extracted = { temp: null, precipProb: null, precipType: null, sky: null, forecastHour: forecastHourForPrompt, tmn: null, tmx: null, tempRange: null, wsd: null, windChill: null };
    let dailyTemps = []; 

    const targetNx = (userNx ?? "").toString().trim();
    const targetNy = (userNy ?? "").toString().trim();

    console.log(`[목표] 날짜: "${forecastDate}", 시간: "${forecastTime}", NX: ${targetNx}, NY: ${targetNy}`);
    let foundMatch = false; 

    for (let r = 1; r < sheet.rowCount; r++) { 
        const date = sheet.getCell(r, 0).value;      // A열 (fcstDate)
        const time = sheet.getCell(r, 1).value;      // B열 (fcstTime)
        const category = sheet.getCell(r, 2).value;  // C열 (category)
        const value = sheet.getCell(r, 3).value;     // D열 (fcstValue)
        const nx = sheet.getCell(r, 4).value;        // E열 (NX)
        const ny = sheet.getCell(r, 5).value;        // F열 (NY)

      const dateFromSheet = (date ?? "").toString().replace(/,/g, '').trim();
      const timeFromSheet = (time ?? "").toString().replace(/,/g, '').trim();
      const nxFromSheet = (nx ?? "").toString().trim();
      const nyFromSheet = (ny ?? "").toString().trim();

      if (dateFromSheet == forecastDate && nxFromSheet == targetNx && nyFromSheet == targetNy) {
        
        if (category === "TMP") {
          dailyTemps.push(parseFloat(value));
        }
        
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

    if (foundMatch) {
        console.log(`[성공] "${forecastTime}"시 데이터를 찾았습니다.`);
    } else {
        console.log(`[실패] "${forecastTime}"시 데이터를 찾지 못했습니다.`);
    }
    
    if (extracted.temp === null) { 
      throw new Error(`Sheet에서 ${forecastDate}/${forecastTime}시 (${targetNx}/${targetNy}) 예보를 찾을 수 없습니다.`); 
    }
    
    // --- 일교차 및 체감온도 계산 ---
    if (dailyTemps.length > 0) {
      extracted.tmx = Math.max(...dailyTemps);
      extracted.tmn = Math.min(...dailyTemps);
      extracted.tempRange = extracted.tmx - extracted.tmn;
    }

    // ⚠️ [수정] 오타 'a'가 확실히 제거된 라인입니다.
    if (extracted.temp !== null && extracted.wsd !== null) {
      const T = extracted.temp, V_kmh = extracted.wsd * 3.6; // 👈 'a' 삭제됨
      if (T <= 10 && V_kmh >= 4.8) {
        const V16 = Math.pow(V_kmh, 0.16);
        extracted.windChill = (13.12 + (0.6215 * T) - (11.37 * V16) + (0.3965 * T * V16)).toFixed(1);
      }
    }
    // --- 계산 끝 ---

    console.log("Google Sheet에서 데이터 읽기 성공!");
    return extracted;

  } catch (e) { 
    console.error("Google Sheet 읽기 오류:", e);
    return null;
  }
}

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
    1. ${data.locationName}의 날씨를 알고 싶어하는 사용자가 ${data.forecastHour}에 참고해야 할 구체적인 행동 지침(우산, 활동)과 옷차림(상의/하의)을 먼저 제시하세요. 옷차림의 자세한 예시도 제시하세요 (예: 니트나 면 소재의 긴팔 상의)
    2. [체감온도/일교차 반영] '체감 온도'나 '일교차' 정보가 있다면, 옷차림 추천 시 (예: "바람이 불어 체감온도가 낮으니 따뜻하게 입으세요", "일교차가 크니 겉옷을 챙기세요") 꼭 반영하세요.
    3. [옷차림 이모지] 옷차림 추천 시 🧥, 👕, 👖 같은 이모지를 사용하세요.
    4. [날씨 설명] 행동 지침 제시 후, 한 줄 띄우고 ${data.locationName}의 날씨 요약을 간략히 설명하세요. '[날씨 설명]'으로 문장을 시작하고, 현재 기온, 하늘 상태, 강수 확률, 형태, 체감온도, 일교차를 반드시 언급하세요.
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

async function getUserInfo(userId) { // ⚠️ 이름 변경: getUserLocation -> getUserInfo
  try {
    await doc.loadInfo(); 
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
    if (!sheet) throw new Error("Subscribers 시트를 찾을 수 없습니다.");

    await sheet.loadHeaderRow(); // Headers: Type, ID, LocationName, NX, NY
    const rows = await sheet.getRows();
    
    const user = rows.find(row => row.get('Type') === 'Private' && row.get('ID').toString() == userId.toString());
    
    if (user) {
      // ⚠️ [수정] 구독자 시트의 D열(NX), E열(NY) 헤더 값을 읽어옵니다.
      return {
        locationName: user.get('LocationName'),
        nx: user.get('NX'),
        ny: user.get('NY')
      };
    }
    return null; // 사용자를 찾지 못함

  } catch (e) {
    console.error("구독자 시트(UserID) 읽기 오류:", e);
    return null;
  }
}

// [ 📄 index.js ]

async function readSubscribers(type) {
  try {
    await doc.loadInfo(); 
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
    if (!sheet) throw new Error("Subscribers 시트를 찾을 수 없습니다.");

    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    
    const subscribers = [];
    for (const row of rows) {
      const rowType = row.get('Type');
      const id = row.get('ID');
      const locationName = row.get('LocationName');
      // ⚠️ [추가] NX, NY 값을 읽어옵니다.
      const nx = row.get('NX');
      const ny = row.get('NY');

      if (type === "Public" && rowType === "Public" && id && nx && ny) { // ⚠️ nx, ny가 있는지 확인
        subscribers.push({ 
            name: `Channel-${id}`, 
            channelId: id, 
            locationName: locationName,
            nx: nx,
            ny: ny 
        });
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

// ... (파일의 다른 함수들은 그대로 둡니다) ...

// =========================================================================
// 5. ⚠️ [수정] UptimeRobot 핑(Ping) 및 Webhook 리스너
// =========================================================================

// (NEW) Render Secrets에서 Webhook 비밀 키를 불러옵니다.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; 

const PORT = process.env.PORT || 10000; 
http.createServer(async (req, res) => {
  try {
    // 1. UptimeRobot 핑 처리 (기존)
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('Discord bot is alive and listening for pings!');
      return;
    }

    // 2. (NEW) Google Form 완료 Webhook 처리
    if (req.method === 'POST' && req.url === '/registration-complete') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString(); // convert Buffer to string
      });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          
          // 3. (NEW) 보안 키 확인
          if (!WEBHOOK_SECRET || data.secret !== WEBHOOK_SECRET) {
            console.warn("Webhook 호출 실패: 잘못된 Secret Key");
            res.writeHead(403, {'Content-Type': 'text/plain'});
            res.end('Forbidden: Invalid secret');
            return;
          }

          // 4. (NEW) DM 발송 함수 호출
          if (data.userId) {
            await sendRegistrationCompleteDM(data.userId);
            console.log(`Webhook 수신: ${data.userId}에게 등록 완료 DM 발송 시도.`);
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('Webhook received and DM queued.');
          } else {
            console.warn("Webhook 호출 실패: userId가 없습니다.");
            res.writeHead(400, {'Content-Type': 'text/plain'});
            res.end('Bad Request: Missing userId');
          }
        } catch (e) {
          console.error("Webhook body 파싱 오류:", e);
          res.writeHead(400, {'Content-Type': 'text/plain'});
          res.end('Bad Request');
        }
      });
      return;
    }

    // 5. 그 외 모든 요청은 404
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('Not Found');

  } catch (e) {
    console.error("HTTP 서버 오류:", e);
    res.writeHead(500, {'Content-Type': 'text/plain'});
    res.end('Internal Server Error');
  }
}).listen(PORT, () => {
  console.log(`HTTP 리스너(Ping/Webhook)가 포트 ${PORT}에서 실행 중입니다.`);
});

/**
 * (NEW) 등록 완료 DM을 발송하는 함수
 */
async function sendRegistrationCompleteDM(userId) {
  try {
    const user = await client.users.fetch(userId);
    if (!user) {
      console.log(`[DM 실패] ID ${userId}에 해당하는 사용자를 찾을 수 없습니다.`);
      return;
    }

    // ⚠️ [수정] /weather를 감싸는 문자를 혼동 없는 작은따옴표(')로 변경
    const message = `
🎉 **등록이 완료되었습니다!**

이제 이 서버의 아무 채널에서나 '/weather' 명령어를 입력하시면,
등록하신 위치의 최신 날씨 정보를 **DM(개인 메시지)**으로 즉시 보내드립니다.
`;

    await user.send(message);
    console.log(`[DM 성공] ${user.tag}님에게 등록 완료 메시지를 보냈습니다.`);
  } catch (e) {
    console.error(`[DM 실패] ${userId}님에게 등록 완료 DM을 보내는 중 오류 발생:`, e);
  }
}
