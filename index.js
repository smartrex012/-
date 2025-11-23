const { Client, GatewayIntentBits, REST, Routes, Events } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const cron = require('node-cron');
const http = require('http');

// --- 0. 설정 ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SUBSCRIBER_SHEET_NAME = "Subscribers";
const FORECAST_SHEET_NAME = "ForecastData";
const CLIENT_ID = process.env.CLIENT_ID;
const TEST_GUILD_ID = process.env.TEST_GUILD_ID;
const GOOGLE_SERVICE_ACCOUNT_CREDS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS);
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Google Sheets 인증
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_CREDS.client_email,
  key: GOOGLE_SERVICE_ACCOUNT_CREDS.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] 
});

// 봇 시작 시 시트 로드
(async () => {
  try { await doc.loadInfo(); console.log('✅ 시트 로드 완료'); } 
  catch (e) { console.error("❌ 시트 로드 실패:", e); }
})();

// --- 1. 명령어 등록 ---
const commands = [{ name: 'weather', description: '현재 위치의 날씨와 행동 지침을 받습니다.' }];
const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
(async () => {
  try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, TEST_GUILD_ID), { body: commands }); console.log('✅ 명령어 등록 완료'); } 
  catch (error) { console.error('❌ 명령어 등록 실패:', error); }
})();

// --- 2. 봇 로그인 및 이벤트 ---
client.once('clientReady', () => { console.log(`✅ ${client.user.tag} 로그인 완료`); });

// [명령어 처리] /weather
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'weather') return;
  await interaction.deferReply({ flags: 64 });

  try {
    const userId = interaction.user.id;
    const userInfo = await getUserInfo(userId);
    if (!userInfo || !userInfo.nx || !userInfo.ny) {
      await interaction.editReply("🚨 등록되지 않은 사용자입니다. 구글 폼으로 먼저 등록해주세요.");
      return;
    }

    // ⚠️ [안전장치] 기상 특보(Kill Switch) 확인
    const alertInfo = await checkEmergencyStatus();
    if (alertInfo.status === "Warning") {
      const warningMessage = `
🚧 **[기상 긴급 경보]**
현재 위험한 기상 특보가 발효 중입니다. 안전을 위해 AI 추천 서비스가 중단됩니다.
**${alertInfo.message}**
※ 기상청 공식 홈페이지나 재난 문자를 반드시 확인하세요.`;
      await interaction.editReply(warningMessage);
      return;
    }

    const times = getApiTime("OnDemand");
    const extractedData = await readDataFromSheet(times.forecastTime, times.forecastHourForPrompt, times.forecastDate, userInfo.nx, userInfo.ny);
    
    if (!extractedData) {
      await interaction.editReply("🚨 데이터를 찾을 수 없습니다. (등록 직후라면 잠시 후 다시 시도하세요)");
      return;
    }

    extractedData.locationName = userInfo.locationName;
    const currentHourKST = getKSTDate(new Date()).hour;
    const finalMessage = await generatePolicyMessage(extractedData, currentHourKST);
    
    await interaction.user.send(finalMessage);
    await interaction.editReply(`✅ DM으로 날씨 정보를 보냈습니다!`);

  } catch (e) {
    console.error("'/weather' 오류:", e);
    await interaction.editReply("🚨 오류가 발생했습니다.");
  }
});

// [멤버 입장] 환영 인사 및 자동 등록
client.on(Events.GuildMemberAdd, async member => {
  console.log(`새 멤버 입장: ${member.user.tag}`);
  
  try { await preRegisterUser(member); } catch (e) { console.error(e); }

  const GOOGLE_FORM_URL = "https://docs.google.com/forms/YOUR_FORM_URL"; // ⚠️ 본인 폼 주소로 변경 필수
  const welcomeDM = `안녕하세요 ${member.user.username}님! 🌦️
1. 본인 ID 복사: \`${member.id}\`
2. 아래 링크에 ID와 동네를 등록해주세요:
> ${GOOGLE_FORM_URL}
등록 후 '/weather' 명령어를 사용하실 수 있습니다.`;

  try { await member.send(welcomeDM); } catch (e) { console.error("DM 전송 실패"); }

  if (WELCOME_CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(WELCOME_CHANNEL_ID);
      if (channel) await channel.send(`<@${member.id}>님 반갑습니다! DM을 확인해주세요 💌`);
    } catch (e) { console.error("환영 메시지 전송 실패", e); }
  }
});

// --- 3. 아침 알림 (스케줄러) ---
cron.schedule('50 6 * * *', async () => {
  console.log("⏰ 아침 알림 시작");
  try {
    // ⚠️ [안전장치] 특보 확인
    const alertInfo = await checkEmergencyStatus();
    if (alertInfo.status === "Warning") return; // 위험 시 아침 알림 생략 (혹은 경고문 전송 가능)

    const kstNow = getKSTDate(new Date());
    const publicChannels = await readSubscribers("Public");
    if (!publicChannels) return;

    for (const channel of publicChannels) {
      try {
        const data = await readDataFromSheet("0700", "7시", kstNow.stringDate, channel.nx, channel.ny);
        if (!data) continue;
        data.locationName = channel.locationName;
        const msg = await generatePolicyMessage(data, 6);
        await sendChannelMessage(channel.channelId, msg, channel.name);
      } catch (e) { console.error(`채널 알림 실패: ${channel.name}`, e); }
    }
  } catch (e) { console.error("스케줄러 오류", e); }
}, { timezone: "Asia/Seoul" });

// --- 4. 헬퍼 함수들 ---

function getKSTDate(date) {
  const kst = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth() + 1, d = kst.getUTCDate();
  return { stringDate: `${y}${m.toString().padStart(2,'0')}${d.toString().padStart(2,'0')}`, hour: kst.getUTCHours() };
}

function getApiTime(mode) { 
  const now = new Date();
  const kst = getKSTDate(now);
  const h = kst.hour;
  // 10분 딜레이 로직 제거됨
  const times = [2,5,8,11,14,17,20,23];
  let target = -1;
  for(const t of times) { if(h < t) break; target = t; }
  
  let baseDate = kst.stringDate;
  let baseTime = "";
  if(target === -1) {
     let y = new Date(now.getTime() - (24*60*60*1000));
     baseDate = getKSTDate(y).stringDate;
     baseTime = "2300";
  } else {
     baseTime = target.toString().padStart(2,'0') + '00';
  }

  let fcstTime = "", fcstHourPrompt = "";
  let fcstDate = kst.stringDate;

  if(mode === "Morning" && h >= 6 && h < 7) {
      fcstTime = "0700"; fcstHourPrompt = "7시";
  } else {
      const avail = [0,3,6,9,12,15,18,21];
      let nextH = avail.find(x => x > h);
      if(nextH === undefined) {
          nextH = 0;
          let tmr = new Date(now.getTime() + (24*60*60*1000));
          fcstDate = getKSTDate(tmr).stringDate;
      }
      fcstTime = nextH.toString().padStart(2,'0') + '00';
      fcstHourPrompt = `${nextH}시`;
  }
  return { baseDate, baseTime, forecastTime: fcstTime, forecastHourForPrompt: fcstHourPrompt, forecastDate: fcstDate };
}

async function checkEmergencyStatus() {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["Metadata"];
    await sheet.loadCells('B2:C2');
    const status = sheet.getCell(1, 1).value; 
    const message = sheet.getCell(1, 2).value;
    return { status: status === "Warning" ? "Warning" : "Normal", message: message };
  } catch (e) { return { status: "Normal" }; }
}

async function getUserInfo(userId) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    const user = rows.find(r => r.get('Type') === 'Private' && r.get('ID').toString() == userId.toString());
    if (user) return { locationName: user.get('LocationName'), nx: user.get('NX'), ny: user.get('NY') };
    return null;
  } catch (e) { return null; }
}

async function readSubscribers(type) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    const subs = [];
    for(const r of rows) {
        if(type === "Public" && r.get('Type') === "Public" && r.get('ID') && r.get('NX')) {
            subs.push({ name: `Channel-${r.get('ID')}`, channelId: r.get('ID'), locationName: r.get('LocationName'), nx: r.get('NX'), ny: r.get('NY') });
        }
    }
    return subs;
  } catch (e) { return null; }
}

async function readDataFromSheet(fcstTime, fcstPrompt, fcstDate, uNx, uNy) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[FORECAST_SHEET_NAME];
    if(sheet.rowCount <= 1) return null;
    
    await sheet.loadCells(`A2:F${sheet.rowCount}`);
    
    const targetNx = (uNx ?? "").toString().trim();
    const targetNy = (uNy ?? "").toString().trim();
    
    let extracted = { temp: null, precipProb: null, precipType: null, sky: null, forecastHour: fcstPrompt, tmn: null, tmx: null, tempRange: null, wsd: null, windChill: null };
    let dailyTemps = [];
    let foundMatch = false;

    for(let r = 1; r < sheet.rowCount; r++) {
        const date = (sheet.getCell(r,0).value ?? "").toString().replace(/,/g,'').trim();
        const time = (sheet.getCell(r,1).value ?? "").toString().replace(/,/g,'').trim();
        const cat = sheet.getCell(r,2).value;
        const val = sheet.getCell(r,3).value;
        const nx = (sheet.getCell(r,4).value ?? "").toString().trim();
        const ny = (sheet.getCell(r,5).value ?? "").toString().trim();

        if(date == fcstDate && nx == targetNx && ny == targetNy) {
            if(cat === "TMP") dailyTemps.push(parseFloat(val));
            if(time == fcstTime) {
                foundMatch = true;
                switch(cat) {
                    case "TMP": extracted.temp = parseFloat(val); break;
                    case "POP": extracted.precipProb = parseInt(val, 10); break;
                    case "PTY": extracted.precipType = val; break;
                    case "SKY": extracted.sky = val; break;
                    case "WSD": extracted.wsd = parseFloat(val); break;
                }
            }
        }
    }
    if(!foundMatch || extracted.temp === null) return null;

    if(dailyTemps.length > 0) {
        extracted.tmx = Math.max(...dailyTemps);
        extracted.tmn = Math.min(...dailyTemps);
        extracted.tempRange = extracted.tmx - extracted.tmn;
    }
    if(extracted.temp !== null && extracted.wsd !== null) {
        const T = extracted.temp, V = extracted.wsd * 3.6;
        if(T <= 10 && V >= 4.8) {
            extracted.windChill = (13.12 + 0.6215*T - 11.37*Math.pow(V,0.16) + 0.3965*T*Math.pow(V,0.16)).toFixed(1);
        }
    }
    return extracted;
  } catch (e) { return null; }
}

async function generatePolicyMessage(data, currentHour) {
  const skyText = (data.sky==='1')?'맑음':(data.sky==='3')?'구름많음':'흐림';
  let precipText = (data.precipProb===0)? "없음" : (data.precipType==='1'?"비":data.precipType==='2'?"비/눈":data.precipType==='3'?"눈":"소나기");
  let windText = (data.windChill)? `${data.windChill}℃` : (data.temp>10?"기온이 높아 계산불가":"바람이 약해 기온과 비슷");
  let rangeText = (data.tempRange)? `${data.tempRange.toFixed(1)}℃` : "";

  const prompt = `
당신은 날씨 데이터를 분석해 "그래서 뭘 해야 하는지"를 알려주는 친절한 '날씨 알리미'입니다. 어투는 긍정적이고 기분 좋게 해주세요.

    [예보 데이터]
    - 현재 요청 시간: ${currentHour}시 (0-23시 사이 24시간제)
    - 위치: ${data.locationName}
    - 예보 시간: ${data.forecastHour}
    - 기온: ${data.temp}℃
    - 하늘 상태: ${skyText}
    - 강수 형태: ${precipText}
    - 강수 확률: ${data.precipProb}%
    - 일교차 정보: ${tempRangeText}
    - 체감온도 정보: ${windChillText} 

    [규칙]
    1.  **인사말 (필수):** [현재 요청 시간]을 바탕으로 시간대에 맞는 인사를 **가장 첫 문장**에 넣어주세요. (예: "편안한 저녁 보내고 계신가요?")
    2.  **행동 지침:** 인사말 다음, '[${data.forecastHour} 행동 지침]'이라는 제목으로 ${data.locationName}의 날씨를 바탕으로 우산 필요 여부(강수 확률/형태), 야외 활동 적합성 등 1-2가지 핵심 조언을 하세요.
    3.  **옷차림 추천:** 다음으로, '[${data.forecastHour} 옷차림]'이라는 제목으로 🧥 상의, 👕 하의, 🧣 기타(겉옷/액세서리) 카테고리로 나누어 어울리는 이모지와 함께, 구체적인 아이템(예: '두툼한 니트', '기모 바지', '경량 패딩')을 추천하세요.
    4.  **데이터 반영 (필수):** 옷차림 추천 시, [일교차 정보]와 [체감온도 정보]를 관련시켜서, 반드시 말로 풀어서 반영하세요. (예: "일교차가 크니 얇은 겉옷을 챙기세요", "바람이 불어 체감온도가 낮으니 목도리가 좋겠어요").
    5.  **날씨 요약 (필수):** 모든 설명이 끝난 후, 한 줄을 띄우고 '[${data.locationName} (${data.forecastHour} 예보)]'라는 제목을 붙인 뒤, 아래 항목들을 **간단한 목록 형식** (예: '* 기온: 7℃')으로 요약하세요. 쉼표나 표 형식을 절대 사용하지 마세요.
        * 기온: ${data.temp}℃
        * 하늘 상태: ${skyText}
        * 강수 확률: ${data.precipProb}%
        * 강수 형태: ${precipText}
        * 체감 온도: ${windChillText}
        * 일교차: ${tempRangeText}
    6.  **마무리 이모지:** 요약 목록 아래에 날씨에 어울리는 ☀️, ☁️, 🌧️ 같은 이모지 1개를 붙이며 마무리하세요.
  `;

  const MAX_RETRIES = 3;
  for(let i=0; i<MAX_RETRIES; i++) {
    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.8, maxOutputTokens: 1000 }
        });
        if(res.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            return res.data.candidates[0].content.parts[0].text.trim();
        }
        break; 
    } catch(e) {
        if(e.response?.status === 503 && i < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, 2000));
        } else {
            break;
        }
    }
  }
  return "🚨 AI 응답 실패 (서버 과부하)";
}

async function preRegisterUser(member) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle[SUBSCRIBER_SHEET_NAME];
        await sheet.loadHeaderRow();
        const rows = await sheet.getRows();
        if(!rows.find(r => r.get('ID').toString() === member.id.toString())) {
            await sheet.addRow({ Type:"Private", ID:member.id, LocationName:member.displayName, NX:"", NY:"" });
        }
    } catch(e) { console.error("Pre-register 오류", e); }
}

async function sendRegistrationCompleteDM(userId) {
    try {
        const user = await client.users.fetch(userId);
        if(user) await user.send("🎉 **등록 완료!** 이제 '/weather' 명령어를 사용해보세요.");
    } catch(e) { console.error("DM 전송 오류", e); }
}

async function sendChannelMessage(chId, msg, name) {
    try {
        const ch = await client.channels.fetch(chId);
        if(ch) await ch.send(msg);
    } catch(e) { console.error("채널 전송 오류", e); }
}

// --- 5. 서버 실행 ---
http.createServer(async (req, res) => {
    if((req.method==='GET'||req.method==='HEAD') && req.url==='/') {
        res.writeHead(200); res.end('OK'); return;
    }
    if(req.method==='POST' && req.url==='/registration-complete') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const d = JSON.parse(body);
                if(!WEBHOOK_SECRET || d.secret !== WEBHOOK_SECRET) { res.writeHead(403); res.end('Forbidden'); return; }
                if(d.userId) { await sendRegistrationCompleteDM(d.userId); res.writeHead(200); res.end('OK'); }
                else { res.writeHead(400); res.end('Bad Request'); }
            } catch(e) { res.writeHead(400); res.end('Error'); }
        });
        return;
    }
    res.writeHead(404); res.end('Not Found');
}).listen(process.env.PORT || 10000, () => console.log("Server running"));

// --- 6. 로그인 ---
client.login(BOT_TOKEN);
