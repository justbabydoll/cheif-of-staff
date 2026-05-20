const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const YOUR_NUMBER = process.env.YOUR_PHONE_NUMBER;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// ─── STATE ────────────────────────────────────────────────────────────────────
let state = {
  // Cycle tracking
  cycleStartDate: new Date('2026-05-15'), // Period started May 15
  cycleLength: 28,
  location: 'Easton, PA',
  timezone: 'America/New_York',

  // Daily health log (resets each day)
  today: {
    date: null,
    bedTime: null,
    wakeTime: null,
    sleepQuality: null,
    nightWaking: null,
    aches: [],
    gut: [],
    energy: null,
    mood: null,
    vitaminC: { breakfast: false, lunch: false, dinner: false },
    rmaVitamins: { breakfast: false, lunch: false, dinner: false },
    meals: { breakfast: null, lunch: null, dinner: null },
    tiktokPosts: 0,
    ideas: [],
  },

  // Projects
  projects: [
    { id: 1, title: "GE Café appliances", status: "active", urgent: true, nextStep: "Find local dealer at cafeappliances.com/where-to-buy. Bundle rebate ends June 30." },
    { id: 2, title: "Hamptons Jewelry Show", status: "active", urgent: true, nextStep: "July 23 at Booth 211. Confirm booth materials and marketing assets are ready." },
    { id: 3, title: "Vault 88 Pinterest", status: "active", urgent: false, nextStep: "Build out Pinterest presence for @vault88jewels." },
    { id: 4, title: "Chief of Staff", status: "active", urgent: false, nextStep: "System live on Render. Campaign approval pending." },
    { id: 5, title: "Help Mom Organize", status: "active", urgent: false, nextStep: "New project — define what needs doing and timeline." },
    { id: 6, title: "Home — Flooring", status: "active", urgent: false, nextStep: "Flooring decision pending." },
  ],

  // Conversation
  conversationHistory: [],
  currentMode: 'idle', // idle, morning_health, project, idea
  currentProject: null,
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getCycleDay() {
  const today = new Date();
  const diff = Math.floor((today - state.cycleStartDate) / (1000 * 60 * 60 * 24));
  return (diff % state.cycleLength) + 1;
}

function getCyclePhase(day) {
  if (day <= 5) return { phase: 'Menstrual', emoji: '🌑', insight: 'Estrogen and progesterone at their lowest. Rest is productive. Gut motility high — frequent BMs are normal. Anti-inflammatory foods help: salmon, ginger, turmeric, leafy greens. Avoid high-nickel foods: oats, nuts, chocolate.' };
  if (day <= 13) return { phase: 'Follicular', emoji: '🌒', insight: 'Estrogen rising. Energy, focus and creativity building. Great time for planning, new projects, and shooting content. Your brain is sharpening.' };
  if (day <= 16) return { phase: 'Ovulation', emoji: '🌕', insight: 'Estrogen peaks. You are at peak confidence, charisma and energy. Best days for content creation, networking, and bold decisions.' };
  return { phase: 'Luteal', emoji: '🌖', insight: 'Progesterone rising then dropping. Energy productive early, PMS territory later. Sugar cravings are hormonal. Magnesium and B6 foods help. Watch nickel intake carefully.' };
}

function shouldAskRMA() {
  const rmaStartDate = new Date('2026-06-03');
  return new Date() >= rmaStartDate;
}

async function getWeather(location) {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: `What is today's weather forecast for ${location}? Give me a one-line summary including temperature and conditions. Also tell me if it's a good day to shoot outdoor video content (good = sunny/partly cloudy, bad = rain/overcast). Format: "☀️ 72°F Sunny — Great shoot day!" or "🌧️ 58°F Rainy — Indoor content today."` }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    });
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return text.trim();
  } catch {
    return '🌤️ Check weather app for today\'s forecast.';
  }
}

async function sendSMS(body) {
  await twilioClient.messages.create({
    body,
    from: FROM_NUMBER,
    to: YOUR_NUMBER,
  });
}

async function askClaude(userMessage, systemPrompt) {
  state.conversationHistory.push({ role: 'user', content: userMessage });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: systemPrompt,
    messages: state.conversationHistory,
  });
  const reply = response.content[0].text;
  state.conversationHistory.push({ role: 'assistant', content: reply });
  // Keep history manageable
  if (state.conversationHistory.length > 20) {
    state.conversationHistory = state.conversationHistory.slice(-20);
  }
  return reply;
}

// ─── MORNING BRIEFING 6:30 AM ─────────────────────────────────────────────────
async function sendMorningBriefing() {
  const day = getCycleDay();
  const { phase, emoji, insight } = getCyclePhase(day);
  const weather = await getWeather(state.location);

  // Reset today's log
  state.today = {
    date: new Date().toDateString(),
    bedTime: null, wakeTime: null, sleepQuality: null, nightWaking: null,
    aches: [], gut: [], energy: null, mood: null,
    vitaminC: { breakfast: false, lunch: false, dinner: false },
    rmaVitamins: { breakfast: false, lunch: false, dinner: false },
    meals: { breakfast: null, lunch: null, dinner: null },
    tiktokPosts: 0, ideas: [],
  };

  state.currentMode = 'morning_health';
  state.conversationHistory = [];

  const urgentProjects = state.projects.filter(p => p.urgent && p.status === 'active');
  const urgentList = urgentProjects.map(p => `🔴 ${p.title}`).join('\n');

  const msg = `Good morning Dana! ☀️

${emoji} Cycle Day ${day} — ${phase}
${insight}

${weather}

${urgentList ? `⚠️ Urgent today:\n${urgentList}\n` : ''}
Let's do your morning check-in first.

🛏️ What time did you go to bed last night?`;

  await sendSMS(msg);
}

// ─── TIKTOK CHECKS ───────────────────────────────────────────────────────────
async function sendTikTokCheck(message) {
  await sendSMS(message);
}

// ─── MEAL CHECK-INS ──────────────────────────────────────────────────────────
async function sendMealCheckin(meal) {
  const mealEmoji = { breakfast: '🍳', lunch: '🥗', dinner: '🍽️' };
  state.currentMode = `meal_${meal}`;
  await sendSMS(`${mealEmoji[meal]} What did you have for ${meal}?`);
}

// ─── GUT CHECK-INS ───────────────────────────────────────────────────────────
async function sendGutCheckin(time) {
  state.currentMode = `gut_${time}`;
  const messages = {
    noon: '💊 Midday gut check — any bowel movements since this morning\'s check-in?\n1. None\n2. Once\n3. Twice\n4. Three or more',
    evening: '🌙 Evening gut check — any bowel movements since this afternoon?\n1. None\n2. Once\n3. Twice\n4. Three or more',
  };
  await sendSMS(messages[time]);
}

// ─── WIND DOWN 9:30 PM ───────────────────────────────────────────────────────
async function sendWindDown() {
  state.currentMode = 'wind_down';
  await sendSMS(`🌙 Wind-down check-in Dana.\n\nAny bowel movements since this afternoon?\n1. None\n2. Once\n3. Twice\n4. Three or more`);
}

// ─── INCOMING SMS HANDLER ────────────────────────────────────────────────────
app.post('/sms', async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const incoming = (req.body.Body || '').trim();
  const lower = incoming.toLowerCase();

  try {
    // ── IDEA CAPTURE (anytime) ──
    if (lower.startsWith('idea:') || lower.startsWith('new:')) {
      const idea = incoming.replace(/^(idea:|new:)/i, '').trim();
      const category = await askClaude(
        `Categorize this idea into one of these projects: GE Café appliances, Hamptons Jewelry Show, Vault 88 Pinterest, Chief of Staff, Help Mom Organize, Home Flooring, Health, or create a new category. Idea: "${idea}". Reply with just the category name.`,
        'You are Dana\'s personal assistant. Categorize ideas concisely.'
      );
      state.today.ideas.push({ idea, category });
      state.projects.push({ id: state.projects.length + 1, title: idea, status: 'active', urgent: false, nextStep: 'New idea — needs planning.' });
      await sendSMS(`💡 Got it! "${idea}" → added to ${category.trim()}`);
      return;
    }

    // ── LOCATION UPDATE ──
    if (lower.startsWith('i\'m in') || lower.startsWith('im in') || lower.startsWith('traveling to')) {
      const location = incoming.replace(/^(i'm in|im in|traveling to)/i, '').trim();
      state.location = location;
      await sendSMS(`📍 Got it — switching weather and timing to ${location}`);
      return;
    }

    // ── MORNING HEALTH CHECK-IN ──
    if (state.currentMode === 'morning_health') {
      await handleMorningHealth(incoming);
      return;
    }

    // ── MEAL CHECK-INS ──
    if (state.currentMode.startsWith('meal_')) {
      const meal = state.currentMode.replace('meal_', '');
      state.today.meals[meal] = incoming;
      state.currentMode = `vitamin_${meal}`;
      let vitMsg = `✅ Logged — ${incoming}\n\nDid you take your Liposomal Vitamin C with ${meal}?\n1. Yes ✅\n2. Not yet\n3. Skipped ❌`;
      if (shouldAskRMA()) vitMsg += `\n\nAlso — RMA vitamins with ${meal}?\n1. Yes ✅\n2. No ❌`;
      await sendSMS(vitMsg);
      return;
    }

    // ── VITAMIN FOLLOW-UP ──
    if (state.currentMode.startsWith('vitamin_')) {
      const meal = state.currentMode.replace('vitamin_', '');
      if (incoming === '1') state.today.vitaminC[meal] = true;
      state.currentMode = 'idle';
      const replies = { '1': '✅ Vitamin C logged!', '2': '💊 Try to take it before your next meal!', '3': 'Noted — skipped.' };
      await sendSMS(replies[incoming] || 'Noted!');
      return;
    }

    // ── GUT CHECK-INS ──
    if (state.currentMode.startsWith('gut_') || state.currentMode === 'wind_down') {
      await handleGutCheckin(incoming);
      return;
    }

    // ── TIKTOK REPLIES ──
    if (state.currentMode === 'tiktok_check') {
      if (incoming === '1') {
        state.today.tiktokPosts++;
        await sendSMS(`🔥 Yes!! ${state.today.tiktokPosts} post${state.today.tiktokPosts > 1 ? 's' : ''} today — keep going!`);
      } else {
        await sendSMS(`No worries — day is young! 🌅`);
      }
      state.currentMode = 'idle';
      return;
    }

    // ── PROJECT MODE ──
    if (state.currentMode === 'project' && state.currentProject) {
      if (lower === 'done') {
        state.currentProject.status = 'complete';
        state.currentMode = 'idle';
        await sendSMS(`✅ Marked complete! Great work. Reply "briefing" to see your project list.`);
        return;
      }
      if (lower === 'next') {
        state.currentMode = 'idle';
        await sendSMS(`Got it — moving on. Reply "briefing" anytime to see your projects.`);
        return;
      }
      const reply = await askClaude(incoming, getProjectSystemPrompt(state.currentProject));
      await sendSMS(reply);
      return;
    }

    // ── BRIEFING COMMAND ──
    if (lower === 'briefing') {
      const active = state.projects.filter(p => p.status === 'active');
      const list = active.map(p => `${p.id}. ${p.urgent ? '🔴 ' : ''}${p.title}`).join('\n');
      await sendSMS(`📋 Your projects:\n\n${list}\n\nReply a number to go deep.`);
      return;
    }

    // ── PROJECT SELECTION BY NUMBER ──
    const num = parseInt(incoming);
    if (!isNaN(num)) {
      const project = state.projects.find(p => p.id === num);
      if (project) {
        state.currentMode = 'project';
        state.currentProject = project;
        await sendSMS(`📌 ${project.title}\n\nNext step: ${project.nextStep}\n\nWhat's the status? Or reply "done" to mark complete, "next" to move on.`);
        return;
      }
    }

    // ── DEFAULT — CLAUDE HANDLES IT ──
    const reply = await askClaude(incoming, getGeneralSystemPrompt());
    await sendSMS(reply);

  } catch (err) {
    console.error('SMS handler error:', err);
    await sendSMS('Something went wrong — try again in a moment.');
  }
});

// ─── MORNING HEALTH FLOW ──────────────────────────────────────────────────────
let healthStep = 0;
let painReported = false;

async function handleMorningHealth(input) {
  healthStep++;

  if (healthStep === 1) {
    state.today.bedTime = input;
    await sendSMS(`🌙 Bed at ${input}.\n\nWhat time did you wake up?`);
  } else if (healthStep === 2) {
    state.today.wakeTime = input;
    await sendSMS(`How was the quality of your sleep?\n\n1. Restless 😵\n2. Light 😕\n3. Okay 😐\n4. Deep 😴\n5. Perfect 🌟`);
  } else if (healthStep === 3) {
    state.today.sleepQuality = input;
    await sendSMS(`Did you wake up during the night?\n\n1. Yes, multiple times\n2. Once\n3. No, slept straight through`);
  } else if (healthStep === 4) {
    state.today.nightWaking = input;
    await sendSMS(`Any aches or pains this morning?\n\n1. Cramps 🔴\n2. Back pain 💢\n3. Neck pain 😣\n4. Headache 🤕\n5. Joint/muscle aches 💪\n6. Breast tenderness 💛\n7. Bloating 😣\n8. Stomach/digestive issues 🤢\n9. Feeling good ✨\n\nPick all that apply (e.g. "2 3 8")`);
  } else if (healthStep === 5) {
    const aches = input.split(/[\s,]+/).map(Number).filter(Boolean);
    state.today.aches = aches;
    painReported = aches.some(a => [2, 3, 5].includes(a));
    const hasGut = aches.includes(8);

    if (painReported) {
      await sendSMS(`Is the pain bad enough to see Dr. Amato today?\n\n1. Yes, call now 📞\n2. No, manageable\n3. I'll see how the day goes`);
    } else if (hasGut) {
      healthStep = 6; // skip to gut
      await sendSMS(`Any bowel movements since waking up?\n\n1. None yet\n2. Once\n3. Twice\n4. Three or more`);
    } else {
      healthStep = 7;
      await sendSMS(`How's your energy this morning?\n\n1. Dead 💀\n2. Low 😴\n3. Okay 😐\n4. Good ⚡\n5. Amazing 🔥`);
    }
  } else if (healthStep === 5.5) {
    // Dr. Amato response
    if (input === '1') {
      await sendSMS(`📞 Call Dr. Anthony Amato:\n(610) 250-0423\n3705 William Penn Hwy, Easton PA\n\nOpen: Mon/Tue/Wed 9am-12pm, Thu 3-7pm, Fri 8:30am-12pm`);
    }
    healthStep = 6;
    await sendSMS(`Any bowel movements since waking up?\n\n1. None yet\n2. Once\n3. Twice\n4. Three or more`);
  } else if (healthStep === 6) {
    state.today.gut.push({ time: 'morning', count: input });
    await sendSMS(`Consistency?\n\n1. Hard lumps 🪨\n2. Lumpy\n3. Cracked sausage\n4. Smooth ✅\n5. Soft blobs\n6. Fluffy/ragged\n7. Watery 💧\n\nOr just describe it.`);
  } else if (healthStep === 6.5) {
    state.today.gut[state.today.gut.length - 1].consistency = input;
    await sendSMS(`Any symptoms?\n\n1. Blood 🔴\n2. Mucus\n3. Unusual color\n4. Pain before\n5. Pain during\n6. Pain after\n7. None ✅`);
  } else if (healthStep === 6.7) {
    state.today.gut[state.today.gut.length - 1].symptoms = input;
    const hasPain = input.includes('4') || input.includes('5') || input.includes('6');
    if (hasPain) {
      await sendSMS(`How would you rate the pain?\n\n1. Mild\n2. Moderate\n3. Severe\n4. Debilitating`);
    } else {
      healthStep = 7;
      await sendSMS(`How's your energy this morning?\n\n1. Dead 💀\n2. Low 😴\n3. Okay 😐\n4. Good ⚡\n5. Amazing 🔥`);
    }
  } else if (healthStep === 6.9) {
    state.today.gut[state.today.gut.length - 1].painLevel = input;
    healthStep = 7;
    await sendSMS(`How's your energy this morning?\n\n1. Dead 💀\n2. Low 😴\n3. Okay 😐\n4. Good ⚡\n5. Amazing 🔥`);
  } else if (healthStep === 7) {
    state.today.energy = input;
    await sendSMS(`Mood?\n\n1. Anxious 😬\n2. Irritable 😤\n3. Flat 😶\n4. Calm 😌\n5. Happy ✨\n6. Overwhelmed 😮‍💨\n7. Motivated 💪`);
  } else if (healthStep === 8) {
    state.today.mood = input;

    // Build summary
    const day = getCycleDay();
    const { phase, emoji } = getCyclePhase(day);
    const energyMap = { '1': 'Dead', '2': 'Low', '3': 'Okay', '4': 'Good', '5': 'Amazing' };
    const moodMap = { '1': 'Anxious', '2': 'Irritable', '3': 'Flat', '4': 'Calm', '5': 'Happy', '6': 'Overwhelmed', '7': 'Motivated' };

    // Chief of Staff briefing
    const urgent = state.projects.filter(p => p.urgent && p.status === 'active');
    const urgentList = urgent.map((p, i) => `${i + 1}. ${p.title}`).join('\n');
    const allActive = state.projects.filter(p => p.status === 'active');
    const projectList = allActive.map(p => `${p.id}. ${p.urgent ? '🔴 ' : ''}${p.title}`).join('\n');

    const summary = `✅ Morning check-in complete!

${emoji} Day ${day} — ${phase}
🛌 ${state.today.bedTime}–${state.today.wakeTime}
⚡ Energy: ${energyMap[state.today.energy] || state.today.energy}
😊 Mood: ${moodMap[state.today.mood] || state.today.mood}

📋 YOUR PROJECTS:
${projectList}

Reply a number to go deep, or "briefing" anytime.

🍳 Breakfast check-in at 10am
📱 TikTok check at 7am`;

    state.currentMode = 'idle';
    healthStep = 0;
    await sendSMS(summary);
  }
}

async function handleGutCheckin(input) {
  const time = state.currentMode.replace('gut_', '').replace('wind_down', 'evening');
  state.today.gut.push({ time, count: input });

  if (input === '1') {
    state.currentMode = 'idle';
    await sendSMS(`None since last check — noted. 💛`);

    if (state.currentMode === 'wind_down') {
      await sendWindDownIdeas();
    }
    return;
  }

  state.currentMode = `gut_followup_${time}`;
  await sendSMS(`Consistency and pain?\n\n1. Normal, no pain ✅\n2. Normal, some pain\n3. Loose, no pain\n4. Loose, with pain\n5. Watery, no pain\n6. Watery, with pain\n\nOr just describe it.`);
}

async function sendWindDownIdeas() {
  state.currentMode = 'wind_down_ideas';
  await sendSMS(`Any new ideas or thoughts today you want to capture?\n\nJust free text anything — I'll sort it. Or reply "none" to wrap up.`);
}

// ─── PROJECT SYSTEM PROMPTS ───────────────────────────────────────────────────
function getProjectSystemPrompt(project) {
  return `You are Dana's personal Chief of Staff AI, communicating via SMS.

Current project: ${project.title}
Next step: ${project.nextStep}

Dana's context:
- Runs Vault 88 Fine Jewelry (@vault88jewels on Instagram and TikTok)
- Hamptons Jewelry Show July 23 at Booth 211
- Based in Easton PA
- Cycle Day ${getCycleDay()} — ${getCyclePhase(getCycleDay()).phase} phase

Rules:
- VERY SHORT replies — this is SMS, max 3-4 sentences
- Ask ONE question at a time
- Be direct and actionable
- If something is completed, acknowledge and ask what's next
- Reply "done" to mark complete, "next" to move on, a number to switch projects`;
}

function getGeneralSystemPrompt() {
  return `You are Dana's personal Chief of Staff AI, communicating via SMS.

Dana's context:
- Runs Vault 88 Fine Jewelry (@vault88jewels)
- Hamptons Jewelry Show July 23 at Booth 211  
- Based in Easton PA
- Cycle Day ${getCycleDay()} — ${getCyclePhase(getCycleDay()).phase} phase
- Managing nickel poisoning — tracking gut health and diet
- Sees Dr. Anthony Amato (chiropractor) at (610) 250-0423 in Easton PA

Rules:
- VERY SHORT replies — SMS only, max 3-4 sentences
- Be warm, direct, and actionable
- Reply "briefing" for project list, a number to go deep on a project`;
}

// ─── CRON JOBS ────────────────────────────────────────────────────────────────
// 6:30 AM ET — Morning briefing + health check-in
cron.schedule('30 6 * * *', () => {
  healthStep = 0;
  sendMorningBriefing();
}, { timezone: 'America/New_York' });

// 7:00 AM ET — TikTok morning check
cron.schedule('0 7 * * *', async () => {
  state.currentMode = 'tiktok_check';
  await sendSMS(`Morning TikTok posted yet? 🎥\n\n1. Yes! 🙌\n2. Not yet`);
}, { timezone: 'America/New_York' });

// 10:00 AM ET — Breakfast
cron.schedule('0 10 * * *', () => {
  sendMealCheckin('breakfast');
}, { timezone: 'America/New_York' });

// 11:00 AM ET — TikTok check
cron.schedule('0 11 * * *', async () => {
  state.currentMode = 'tiktok_check';
  await sendSMS(`TikTok posted yet today? 📱\n\n1. Yes, posted! 🙌\n2. Not yet`);
}, { timezone: 'America/New_York' });

// 12:00 PM ET — Gut check
cron.schedule('0 12 * * *', () => {
  sendGutCheckin('noon');
}, { timezone: 'America/New_York' });

// 1:30 PM ET — Lunch
cron.schedule('30 13 * * *', () => {
  sendMealCheckin('lunch');
}, { timezone: 'America/New_York' });

// 2:00 PM ET — TikTok check
cron.schedule('0 14 * * *', async () => {
  state.currentMode = 'tiktok_check';
  await sendSMS(`Afternoon content window! 📱✨\n\nTikTok posted since this morning?\n\n1. Yes, another one! 🔥\n2. Just the one so far\n3. Not yet today`);
}, { timezone: 'America/New_York' });

// 5:00 PM ET — TikTok golden hour
cron.schedule('0 17 * * *', async () => {
  state.currentMode = 'tiktok_check';
  await sendSMS(`🌅 Golden hour — best light of the day!\n\nTikTok posted since this afternoon?\n\n1. Yes, got another one! 🔥\n2. Sticking with what I have\n3. Not yet — still time!`);
}, { timezone: 'America/New_York' });

// 7:30 PM ET — Dinner
cron.schedule('30 19 * * *', () => {
  sendMealCheckin('dinner');
}, { timezone: 'America/New_York' });

// 9:30 PM ET — Wind down + gut + ideas
cron.schedule('30 21 * * *', () => {
  sendWindDown();
}, { timezone: 'America/New_York' });

// ─── TEST ENDPOINT ────────────────────────────────────────────────────────────
app.get('/test', async (req, res) => {
  try {
    healthStep = 0;
    await sendMorningBriefing();
    res.json({ success: true, message: 'Morning briefing sent to your phone!' });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: '🎯 Chief of Staff is running!' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chief of Staff running on port ${PORT}`));
