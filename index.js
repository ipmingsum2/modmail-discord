import 'dotenv/config';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, Client, EmbedBuilder, Events,
  GatewayIntentBits, Partials, PermissionFlagsBits,
  // ActivityType, // not used since we’re using numeric type
} from 'discord.js';

const { DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID || !FORUM_CHANNEL_ID) {
  console.error('Set DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID');
  process.exit(1);
}

const PREFIX = 'mm!';
const COOLDOWN_MS = 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// State
const userToThread = new Map();
const threadToUser = new Map();
const blacklist = new Set();
const lastDMRelayAt = new Map();
const warnData = new Map();
const closedThreads = new Set();

const ids = { yes: (u) => `mm_yes_${u}`, no: (u) => `mm_no_${u}` };

const embed = {
  blacklist: () => new EmbedBuilder()
    .setTitle('Blacklisted')
    .setDescription('You have been blacklisted from opening threads.')
    .setFooter({ text: 'ModMail' })
    .setColor(0xff3b30),

  confirm: () => new EmbedBuilder()
    .setTitle('ModMail')
    .setDescription('Would you like to open a ticket? Please note that abusing this system will get you **blacklisted**.')
    .setFooter({ text: 'ModMail' })
    .setColor(0x00b5ff),

  warnDM: (reason) => new EmbedBuilder()
    .setTitle('Warned')
    .setDescription(`You have been warned for ${reason}, please use the ModMail system properly.`)
    .setFooter({ text: 'ModMail' })
    .setColor(0xffcc00),
};

const confirmRow = (u) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ids.yes(u)).setLabel('Yes').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ids.no(u)).setLabel('No').setStyle(ButtonStyle.Danger),
  );

const inForumThread = (ch) =>
  (ch?.type === ChannelType.PublicThread || ch?.type === ChannelType.PrivateThread) &&
  ch.parent?.id === FORUM_CHANNEL_ID;

const addSuccessReaction = async (msg) => {
  try { await msg.react('✅'); } catch {}
};

async function createFreshThread(user, forum) {
  const th = await forum.threads.create({
    name: `ModMail: ${user.tag ?? user.username} [${user.id}]`,
    message: { content: `New ModMail opened by <@${user.id}> (${user.tag ?? user.username}).` },
  });
  const oldId = userToThread.get(user.id);
  if (oldId) {
    threadToUser.delete(oldId);
  }
  userToThread.set(user.id, th.id);
  threadToUser.set(th.id, user.id);
  closedThreads.delete(th.id);
  return th;
}

async function forwardDMToThread(dm, thread) {
  const text = dm.content?.trim() || '(no text)';
  const files = [...dm.attachments.values()].map(a => a.url);
  await thread.send({ content: `**<@${dm.author.id}>**: ${text}`, files });
  await addSuccessReaction(dm);
}

async function forwardStaffToUser(msg, user) {
  const text = msg.content?.trim() || '(no text)';
  const files = [...msg.attachments.values()].map(a => a.url);
  await user.send({ content: `**Staff**: ${text}`, files });
  await addSuccessReaction(msg);
}

function parseUser(arg) {
  if (!arg) return null;
  const m = arg.match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return m ? (m[1] || m[2]) : null;
}

function getWarns(uid) { return warnData.get(uid) || []; }
function pushWarn(uid, entry) {
  const arr = getWarns(uid).slice();
  arr.push(entry);
  warnData.set(uid, arr);
  return arr.length;
}
function clearWarns(uid) { warnData.delete(uid); }
function removeWarn(uid, index1Based) {
  const arr = getWarns(uid).slice();
  if (index1Based < 1 || index1Based > arr.length) return { ok: false, remaining: arr.length };
  arr.splice(index1Based - 1, 1);
  if (arr.length === 0) warnData.delete(uid);
  else warnData.set(uid, arr);
  return { ok: true, remaining: arr.length };
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Use numeric type (3 = Watching) for maximum compatibility
  try {
    client.user.setActivity('DMs', { type: 3 });
    // client.user.setPresence({ activities: [{ name: 'DMs', type: 3 }], status: 'online' });
  } catch (e) {
    console.error('Failed to set presence:', e);
  }
});

// Handle user DMs to bot
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.guildId) return;
  if (!message.content && message.attachments.size === 0) return;

  const uid = message.author.id;

  if (blacklist.has(uid)) {
    await message.channel.send({ embeds: [embed.blacklist()] }).catch(() => {});
    return;
  }

  let activeThreadId = userToThread.get(uid);
  if (activeThreadId) {
    try {
      const ch = await client.channels.fetch(activeThreadId).catch(() => null);
      if (!inForumThread(ch)) {
        userToThread.delete(uid);
        if (ch?.id) threadToUser.delete(ch.id);
        activeThreadId = null;
      } else {
        await ch.fetch(true).catch(() => {});
        if (closedThreads.has(ch.id) || ch.archived || ch.locked) {
          userToThread.delete(uid);
          threadToUser.delete(ch.id);
          activeThreadId = null;
        }
      }
    } catch {
      userToThread.delete(uid);
      activeThreadId = null;
    }
  }

  if (activeThreadId) {
    const nowMs = Date.now(), last = lastDMRelayAt.get(uid) || 0;
    if (nowMs - last < COOLDOWN_MS) return;
    lastDMRelayAt.set(uid, nowMs);
    try {
      const ch = await client.channels.fetch(activeThreadId).catch(() => null);
      if (inForumThread(ch)) {
        await forwardDMToThread(message, ch);
        return;
      }
    } catch {}
  }

  await message.channel.send({ embeds: [embed.confirm()], components: [confirmRow(uid)] }).catch(() => {});
});

// Handle confirmation buttons
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;
  const u = i.user?.id; if (!u) return;
  const isYes = i.customId === ids.yes(u), isNo = i.customId === ids.no(u);
  if (!isYes && !isNo) return;

  if (blacklist.has(u)) { await i.update({ embeds: [embed.blacklist()], components: [] }); return; }
  if (isNo) { await i.update({ content: 'Okay! If you need help later, just message me again.', embeds: [], components: [] }); return; }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const forum = await guild.channels.fetch(FORUM_CHANNEL_ID);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      await i.update({ content: 'Configuration error: Forum channel not found.', embeds: [], components: [] });
      return;
    }
    const thread = await createFreshThread(i.user, forum);
    await i.update({ content: 'Ticket opened. You can continue messaging here.', embeds: [], components: [] });
    await thread.send(`Ticket confirmed by <@${u}>.`).catch(() => {});
  } catch {
    await i.update({ content: 'Failed to create a ticket. Please try again later.', embeds: [], components: [] }).catch(() => {});
  }
});

// Guild messages: commands + staff relay
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guildId) return;

  if (message.content?.startsWith(PREFIX)) {
    let staff = false;
    try {
      const member = await message.guild.members.fetch(message.author.id);
      staff = member.permissions.has(PermissionFlagsBits.ManageThreads) ||
              member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
              member.permissions.has(PermissionFlagsBits.ManageMessages) ||
              member.permissions.has(PermissionFlagsBits.Administrator);
    } catch {}
    if (!staff) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (args.shift() || '').toLowerCase();

    if (cmd === 'cmds' || cmd === 'commands') {
      const h = new EmbedBuilder()
        .setTitle('ModMail Commands')
        .setColor(0x00b5ff)
        .setDescription(
          [
            `Prefix: ${PREFIX}`,
            '',
            `User management:`,
            `• ${PREFIX}warn <user|id> <reason>`,
            `• ${PREFIX}warnlist <user|id>`,
            `• ${PREFIX}clearwarns <user|id>`,
            `• ${PREFIX}removewarn <user|id> <case#>`,
            `• ${PREFIX}dm <user|id> <message>`,
            `• ${PREFIX}blacklist <user|id>`,
            `• ${PREFIX}unblacklist <user|id>`,
            '',
            `Ticket controls (run inside a ModMail thread):`,
            `• ${PREFIX}close [reason]`,
            `• ${PREFIX}reopen`,
            '',
            `Meta:`,
            `• ${PREFIX}cmds (this menu)`,
          ].join('\n')
        );
      await message.reply({ embeds: [h] });
      return;
    }

    if (cmd === 'warn') {
      const uid = parseUser(args.shift());
      const reason = (args.join(' ') || '').trim();
      if (!uid || !reason) return;

      // Store epoch seconds for timestamps
      const entry = { reason, at: Math.floor(Date.now() / 1000), by: message.author.id };
      const total = pushWarn(uid, entry);

      try { const user = await client.users.fetch(uid); await user.send({ embeds: [embed.warnDM(reason)] }); } catch {}
      try { await message.reply(`Warned <@${uid}>. Count: ${total}`); } catch {}

      if (total >= 3 && !blacklist.has(uid)) {
        blacklist.add(uid);
        try { await message.channel.send(`User <@${uid}> has reached 3 warnings and was auto-blacklisted.`); } catch {}
        const thId = userToThread.get(uid);
        if (thId) {
          const ch = await client.channels.fetch(thId).catch(() => null);
          if (inForumThread(ch)) await ch.send('Note: User auto-blacklisted after 3 warnings.').catch(() => {});
        }
      }
      return;
    }

    if (cmd === 'warnlist') {
      const uid = parseUser(args.shift());
      if (!uid) return;
      const warns = getWarns(uid);
      if (warns.length === 0) {
        await message.reply(`No warnings found for <@${uid}>.`).catch(() => {});
        return;
      }
      // Use <t:...:f> only here
      const lines = warns.map((w, i) => `Warning ${i + 1} • ${w.reason} • by <@${w.by}> on <t:${w.at}:f>`);
      const em = new EmbedBuilder()
        .setTitle(`Warnings for ${uid}`)
        .setColor(0xffcc00)
        .setDescription(lines.join('\n'));
      await message.reply({ embeds: [em] }).catch(() => {});
      return;
    }

    if (cmd === 'clearwarns') {
      const uid = parseUser(args.shift());
      if (!uid) return;
      const had = getWarns(uid).length;
      clearWarns(uid);
      await message.reply(`Cleared ${had} warning(s) for <@${uid}>.`).catch(() => {});
      return;
    }

    if (cmd === 'removewarn') {
      const uid = parseUser(args.shift());
      const caseStr = args.shift();
      if (!uid || !caseStr) return;
      const idx = parseInt(caseStr, 10);
      if (!Number.isInteger(idx)) {
        await message.reply('Case number must be an integer.').catch(() => {});
        return;
      }
      const res = removeWarn(uid, idx);
      if (!res.ok) {
        await message.reply(`Invalid case. Use ${PREFIX}warnlist <user> to see available cases.`).catch(() => {});
        return;
      }
      await message.reply(`Removed warning #${idx} for <@${uid}>. Remaining: ${res.remaining}.`).catch(() => {});
      return;
    }

    if (cmd === 'dm') {
      const uid = parseUser(args.shift());
      const msgText = (args.join(' ') || '').trim();
      if (!uid || !msgText) return;
      try {
        const user = await client.users.fetch(uid);
        await user.send({ content: msgText });
        await addSuccessReaction(message);
        await message.reply(`DM sent to <@${uid}>.`).catch(() => {});
      } catch {
        await message.reply(`Could not DM <@${uid}>. They may have DMs closed.`).catch(() => {});
      }
      return;
    }

    if (cmd === 'blacklist') {
      const uid = parseUser(args[0]); if (!uid) return;
      blacklist.add(uid);
      try { await message.reply(`User <@${uid}> blacklisted.`); } catch {}
      const thId = userToThread.get(uid);
      if (thId) { const ch = await client.channels.fetch(thId).catch(() => null); if (inForumThread(ch)) await ch.send('Note: User blacklisted.'); }
      return;
    }

    if (cmd === 'unblacklist') {
      const uid = parseUser(args[0]); if (!uid) return;
      if (!blacklist.has(uid)) return;
      blacklist.delete(uid);
      try { await message.reply(`User <@${uid}> unblacklisted.`); } catch {}
      return;
    }

    if (cmd === 'close') {
      const ch = message.channel;
      if (!inForumThread(ch)) return;

      await ch.fetch(true).catch(() => {});
      if (ch.locked || ch.archived || closedThreads.has(ch.id)) {
        await message.reply('This ticket is already closed.').catch(() => {});
        return;
      }

      let uid = threadToUser.get(ch.id);
      if (!uid) {
        const m = ch.name?.match(/(\d{17,20})]$/);
        if (m) { uid = m[1]; threadToUser.set(ch.id, uid); userToThread.set(uid, ch.id); }
      }

      const reason = args.join(' ').trim() || 'No reason provided';

      if (uid) {
        try {
          const user = await client.users.fetch(uid);
          await user.send(`**Staff**: Your ModMail ticket has been closed. Reason: ${reason}`);
        } catch {}
      }

      closedThreads.add(ch.id);
      if (uid) userToThread.delete(uid);
      threadToUser.delete(ch.id);

      try { await ch.send(`Closing thread. Reason: ${reason}`); } catch {}
      try {
        await ch.setLocked(true, `Closed by ${message.author.tag}: ${reason}`);
        await ch.setArchived(true, `Closed by ${message.author.tag}: ${reason}`);
      } catch {}

      return;
    }

    if (cmd === 'reopen') {
      const ch = message.channel;
      if (!inForumThread(ch)) return;

      await ch.fetch(true).catch(() => {});
      if (!ch.archived && !ch.locked && !closedThreads.has(ch.id)) {
        await message.reply('This ticket is already open.').catch(() => {});
        return;
      }

      closedThreads.delete(ch.id);
      try {
        await ch.setArchived(false, `Reopened by ${message.author.tag}`);
        await ch.setLocked(false, `Reopened by ${message.author.tag}`);
      } catch {}

      let uid = threadToUser.get(ch.id);
      if (!uid) {
        const m = ch.name?.match(/(\d{17,20})]$/);
        if (m) uid = m[1];
      }
      if (uid) {
        threadToUser.set(ch.id, uid);
        userToThread.set(uid, ch.id);
      }

      await message.reply('Ticket reopened.').catch(() => {});
      return;
    }

    return;
  }

  const ch = message.channel;
  if (!inForumThread(ch)) return;

  await ch.fetch(true).catch(() => {});
  if (ch.locked || ch.archived || closedThreads.has(ch.id)) return;

  let uid = threadToUser.get(ch.id);
  if (!uid) {
    const m = ch.name?.match(/(\d{17,20})]$/);
    if (m) { uid = m[1]; threadToUser.set(ch.id, uid); userToThread.set(uid, ch.id); }
  }
  if (!uid) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  const staff = !!member && (
    member.permissions.has(PermissionFlagsBits.ManageThreads) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
  if (!staff) return;

  if (!message.content && message.attachments.size === 0) return;

  const user = await client.users.fetch(uid).catch(() => null);
  if (!user) return;
  try {
    await forwardStaffToUser(message, user);
  } catch {}
});

client.login(DISCORD_TOKEN);
