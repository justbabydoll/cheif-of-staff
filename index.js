const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
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

// In-memory conversation state (persists while server runs)
let conversationHistory = [];
let waitingForReply = false;

// ─── PROJECTS ────────────────────────────────────────────────────────────────
// Edit this list anytime to add/remove/update projects
let projects = [
  { id: 1, title: "GE Café appliances", status: "active", urgent: true, nextStep: "Find local dealer at cafeappliances.com/where-to-buy. Bundle rebate ends June 30." },
  { id: 2, title: "DOGE trading bot", status: "active", urgent: false, nextStep: "Apply get_bid_ask patch to doge_bot.py on Desktop, then run it in Cowork." },
  { id: 3, title: "Hamptons Jewelry Show", status: "active", urgent: false, nextStep: "July 23 at Booth 211. Confirm booth materials and marketing assets are ready." },
  { id: 4, title: "Monogram gift for friend", status: "active", urgent: false, nextStep: "Order VEVOR hot foil machine and brass BACK die from Etsy. Test on scrap leather first." },
  { id: 5, title: "Cycle tracking SMS system", status: "active", urgent: false, nextStep: "Twilio is now set up. Build the daily check-in bot." },
  { id: 6, title: "Facial exercise follow-along app", status: "active", urgent: false, nextStep: "Screenshot saved Instagram exercise folders and share them to build the timed app." },
  { id: 7, title: "Front yard succession planting", status: "active", urgent: false, nextStep: "Buy hellebores now. Roses in June. Perennials in fall." },
  { id: 8, title: "Elixir Wellness brand strategy", status: "active", urgent: false, nextStep: "Share the Shit Talking town hall concept and YouTube series plan with Yuliya." },
  { id: 9, title: "Organic farm inspector career", status: "active", urgent: false, nextStep: "Text your inspector friend (message is drafted). Then send the PCO email this week." },
  { id: 10, title: "Vault 88 Pinterest", status: "active", urgent: false, nextStep: "Build out Pinterest presence for vault88jewels alongside Instagram and TikTok." },
];

// ─── SEND SMS ─────────────────────────────────────────────────────────────────
async function sendSMS(body) {
  await twilioClient.messages.create({ body, from: FROM_NUMBER, to: YOUR_NUMBER });
  console.log('SMS sent:', body.substring(0, 60) + '...');
}

// ─── BUILD MORNING BRIEFING ───────────────────────────────────────────────────
function buildBriefing() {
  const active = projects.filter(p => p.status === 'active');
  const urgent = active.filter(p => p.urgent);
  const normal = active.filter(p => !p.urgent);
  const sorted = [...urgent, ...normal];

  let msg = `Good morning Dana. Here's everything open:\n\n`;
  sorted.forEach((p, i) => {
    const flag = p.urgent ? '🔴 ' : '';
    msg += `${i + 1}. ${flag}${p.title}\n`;
  });
  msg += `\nReply a number to go deep on any project, "all" to work through everything, or "new: [idea]" to add something.`;
  return { msg, sorted };
}

// ─── MORNING BRIEFING (runs 8am ET daily) ────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  console.log('Sending morning briefing...');
  conversationHistory = [];
  waitingForReply = true;
  const { msg, sorted } = buildBriefing();
  // Store sorted order for reply matching
  global.lastBriefingOrder = sorted;
  await sendSMS(msg);
}, { timezone: "America/New_York" });

// ─── HANDLE INCOMING SMS REPLIES ─────────────────────────────────────────────
app.post('/sms', async (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body?.trim() || '';
  console.log('Incoming:', incomingMsg);

  try {
    // Handle archive command
    if (incomingMsg.toLowerCase().startsWith('archive ')) {
      const num = parseInt(incomingMsg.split(' ')[1]);
      const order = global.lastBriefingOrder || projects;
      const proj = order[num - 1];
      if (proj) {
        projects = projects.map(p => p.id === proj.id ? { ...p, status: 'archived' } : p);
        twiml.message(`✅ "${proj.title}" archived. It won't show up in future briefings.`);
      } else {
        twiml.message(`Couldn't find project ${num}. Try "archive [number]" using the number from your last briefing.`);
      }
      res.type('text/xml');
      res.send(twiml.toString());
      return;
    }

    // Handle new idea
    if (incomingMsg.toLowerCase().startsWith('new:')) {
      const idea = incomingMsg.substring(4).trim();
      const newId = Math.max(...projects.map(p => p.id)) + 1;
      projects.push({ id: newId, title: idea, status: 'active', urgent: false, nextStep: 'New — define next step.' });
      twiml.message(`✅ Added "${idea}" to your projects. I'll include it in tomorrow's briefing.`);
      res.type('text/xml');
      res.send(twiml.toString());
      return;
    }

    // Handle "all" — work through everything
    if (incomingMsg.toLowerCase() === 'all') {
      global.lastBriefingOrder = global.lastBriefingOrder || projects.filter(p => p.status === 'active');
      global.currentProjectIndex = 0;
      const firstProject = global.lastBriefingOrder[0];
      if (firstProject) {
        const reply = await askAboutProject(firstProject);
        twiml.message(reply);
      }
      res.type('text/xml');
      res.send(twiml.toString());
      return;
    }

    // Handle number selection from briefing
    const num = parseInt(incomingMsg);
    if (!isNaN(num) && global.lastBriefingOrder) {
      const proj = global.lastBriefingOrder[num - 1];
      if (proj) {
        global.currentProject = proj;
        conversationHistory = [];
        const reply = await askAboutProject(proj);
        twiml.message(reply);
        res.type('text/xml');
        res.send(twiml.toString());
        return;
      }
    }

    // Handle "next" — move to next project in "all" mode
    if (incomingMsg.toLowerCase() === 'next' && global.lastBriefingOrder) {
      global.currentProjectIndex = (global.currentProjectIndex || 0) + 1;
      const nextProj = global.lastBriefingOrder[global.currentProjectIndex];
      if (nextProj) {
        global.currentProject = nextProj;
        conversationHistory = [];
        const reply = await askAboutProject(nextProj);
        twiml.message(reply);
      } else {
        twiml.message(`That's everything for today. Good work Dana. 💪`);
      }
      res.type('text/xml');
      res.send(twiml.toString());
      return;
    }

    // Handle done/complete for current project
    if (['done', 'complete', 'finished'].includes(incomingMsg.toLowerCase()) && global.currentProject) {
      projects = projects.map(p => p.id === global.currentProject.id ? { ...p, status: 'done' } : p);
      twiml.message(`✅ "${global.currentProject.title}" marked complete! Reply "next" for the next project or "briefing" to see everything.`);
      res.type('text/xml');
      res.send(twiml.toString());
      return;
    }

    // Handle "briefing" — resend the full list
    if (incomingMsg.toLowerCase() === 'briefing') {
      const { msg, sorted } = buildBriefing();
      global.lastBriefingOrder = sorted;
      twiml.message(msg);
      res.type('text/xml');
      res.send(twiml.toString());
      return;
    }

    // Default: continue conversation with Claude about current project
    const systemPrompt = buildSystemPrompt();
    conversationHistory.push({ role: 'user', content: incomingMsg });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: conversationHistory,
    });

    const reply = response.content[0].text;
    conversationHistory.push({ role: 'assistant', content: reply });

    // Update project next step if Claude mentions one
    if (global.currentProject && reply.includes('Next step:')) {
      const nextStepMatch = reply.match(/Next step: (.+)/);
      if (nextStepMatch) {
        projects = projects.map(p =>
          p.id === global.currentProject.id ? { ...p, nextStep: nextStepMatch[1] } : p
        );
      }
    }

    twiml.message(reply);
  } catch (err) {
    console.error('Error:', err);
    twiml.message('Something went wrong on my end. Try again in a moment.');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ─── ASK ABOUT A PROJECT ─────────────────────────────────────────────────────
async function askAboutProject(project) {
  const prompt = `You are Dana's personal Chief of Staff. Ask ONE focused question about this project to move it forward. Be brief and direct — this is SMS. End with a simple reply option like Yes/No or a specific action.

Project: ${project.title}
Current next step: ${project.nextStep}
Status: ${project.status}

Ask your single most important question to get this project moving today.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const reply = response.content[0].text;
  conversationHistory = [{ role: 'assistant', content: reply }];
  return reply;
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const proj = global.currentProject;
  const projContext = proj ? `Current project: ${proj.title}. Next step: ${proj.nextStep}.` : 'General project discussion.';

  return `You are Dana's personal Chief of Staff AI. You help Dana manage all her projects and get things done via SMS.

${projContext}

Rules:
- Keep replies SHORT — this is SMS, max 3-4 sentences
- Ask ONE question at a time
- Be direct and actionable
- If Dana completes something, say "Next step: [what comes next]" so it gets saved
- If Dana wants to move on, tell her to reply "next"
- If she wants to mark something done, tell her to reply "done"
- You know Dana runs Vault 88 Fine Jewelry and has a Hamptons show July 23 at Booth 211
- Dana is in Easton PA
- Be warm but efficient — she's busy`;
}

// ─── TEST ENDPOINT ────────────────────────────────────────────────────────────
app.get('/test', async (req, res) => {
  try {
    const { msg, sorted } = buildBriefing();
    global.lastBriefingOrder = sorted;
    await sendSMS(msg);
    res.json({ success: true, message: 'Morning briefing sent to your phone!' });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'Chief of Staff is running 🎯' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chief of Staff running on port ${PORT}`));
