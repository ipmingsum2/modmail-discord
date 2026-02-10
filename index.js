import 'dotenv/config';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, Client, EmbedBuilder, Events,
  GatewayIntentBits, Partials, PermissionFlagsBits,
} from 'discord.js';

const { DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID || !FORUM_CHANNEL_ID) { console.error('Set DISCORD_TOKEN, GUILD_ID, FORUM_CHANNEL_ID'); process.exit(1); }

const PREFIX = 'mm!';
const COOLDOWN_MS = 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const userToThread = new Map();
const threadToUser = new Map();
const blacklist = new Set();
const lastDMRelayAt = new Map();
const warnCounts = new Map();

const ids = { yes: (u) => `mm_yes_${u}`, no: (u) => `mm_no_${u}` };

const embed = {
  blacklist: () => new EmbedBuilder()
    .setTitle('Blacklisted').setDescription('You have been blacklisted from opening threads.')
    .setFooter({ text: 'ModMail' }).setColor(0xff3b30),
  confirm: () => new EmbedBuilder()
    .setTitle('ModMail').setDescription('Would you like to open a ticket?')
    .setFooter({ text: 'ModMail' }).setColor(0x00b5ff),
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

async function getOrCreateThread(user, forum) {
  const cached = userToThread.get(user.id);
  if (cached) {
    try { const th = await forum.threads.fetch(cached); if (th && !th.archived) return th; } catch {}
  }
  const active = await forum.threads.fetchActive();
  const found = active.threads.find(t => t.name?.includes(`[${user.id}]`) && !t.archived);
  if (found) { userToThread.set(user.id, found.id); threadToUser.set(found.id, user.id); return found; }
  const th = await forum.threads.create({
    name: `ModMail: ${user.tag ?? user.username} [${user.id}]`,
    message: { content: `New ModMail opened by <@${user.id}> (${user.tag ?? user.username}).` },
  });
  userToThread.set(user.id, th.id); threadToUser.set(th.id, user.id);
  return th;
}

async function forwardDMToThread(dm, thread) {
  const text = dm.content?.trim() || '(no text)';
  await thread.send({ content: `**<@${dm.author.id}>**: ${text}`, files: [...dm.attachments.values()].map(a => a.url) });
  msg.react("✅");
}

async function forwardStaffToUser(msg, user) {
  const text = msg.content?.trim() || '(no text)';
  try {
    await user.send({ content: `**Staff**: ${text}`, files: [...msg.attachments.values()].map(a => a.url) });
  } catch {
    try { await msg.channel.send(`Could not DM <@${user.id}>.`); } catch {}
  }
  msg.react("✅");
}

function parseUser(arg) {
  if (!arg) return null;
  const m = arg.match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return m ? (m[1] || m[2]) : null;
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('my DMs',{type: 'WATCHING'}); 
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const forum = await guild.channels.fetch(FORUM_CHANNEL_ID);
    if (!forum || forum.type !== ChannelType.GuildForum) { console.error('Forum not found'); return; }
    const active = await forum.threads.fetchActive();
    for (const [, th] of active.threads) {
      const m = th.name?.match(/[(\d{17,20})]$/);
      if (m) { userToThread.set(m[1], th.id); threadToUser.set(th.id, m[1]); }
    }
  } catch (e) { console.warn('Startup index failed:', e.message); }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.guildId) return;
  if (!message.content && message.attachments.size === 0) return;
  const uid = message.author.id;

  if (blacklist.has(uid)) {
    await message.channel.send({ embeds: [embed.blacklist()] }).catch(() => {});
    return;
  }

  const thId = userToThread.get(uid);
  if (thId) {
    const now = Date.now(), last = lastDMRelayAt.get(uid) || 0;
    if (now - last < COOLDOWN_MS) return;
    lastDMRelayAt.set(uid, now);
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const forum = await guild.channels.fetch(FORUM_CHANNEL_ID);
      const thread = await forum.threads.fetch(thId).catch(() => null);
      if (thread && !thread.archived) { await forwardDMToThread(message, thread); return; }
      userToThread.delete(uid);
    } catch { userToThread.delete(uid); }
  }

  await message.channel.send({ embeds: [embed.confirm()], components: [confirmRow(uid)] }).catch(() => {});
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;
  const u = i.user?.id; if (!u) return;
  const isYes = i.customId === ids.yes(u), isNo = i.customId === ids.no(u);
  if (!isYes && !isNo) return;

  if (blacklist.has(u)) { await i.update({ embeds: [embed.blacklist()], components: [] }); return; }
  if (isNo) { await i.update({ content: 'Okay! If you need help later, just message me again.', embeds: [], components: [] }); return; }

  const guild = await client.guilds.fetch(GUILD_ID);
  const forum = await guild.channels.fetch(FORUM_CHANNEL_ID);
  if (!forum || forum.type !== ChannelType.GuildForum) { await i.update({ content: 'Configuration error: Forum channel not found.', embeds: [], components: [] }); return; }
  const thread = await getOrCreateThread(i.user, forum);
  await i.update({ content: 'Ticket opened. You can continue messaging here.', embeds: [], components: [] });
  await thread.send(`Ticket confirmed by <@${u}>.`).catch(() => {});
});

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
      const h = new EmbedBuilder().setTitle('ModMail Commands').setColor(0x00b5ff).setDescription(
        [
          `Prefix: ${PREFIX}`, '',
          `• ${PREFIX}warn <user|id> <reason>`,
          `• ${PREFIX}dm <user|id> <message>`,
          `• ${PREFIX}blacklist <user|id>`,
          `• ${PREFIX}unblacklist <user|id>`,
          `• ${PREFIX}close [reason]`,
          `• ${PREFIX}cmds`,
        ].join('\n')
      );
      await message.reply({ embeds: [h] }); return;
    }

    if (cmd === 'warn') {
      const uid = parseUser(args.shift());
      const reason = (args.join(' ') || '').trim();
      if (!uid || !reason) return;
      const count = (warnCounts.get(uid) || 0) + 1;
      warnCounts.set(uid, count);
      try { const user = await client.users.fetch(uid); await user.send({ embeds: [embed.warnDM(reason)] }); } catch {}
      try { await message.reply(`Warned <@${uid}>. Count: ${count}/3`); } catch {}
      if (count >= 3 && !blacklist.has(uid)) {
        blacklist.add(uid);
        try { await message.channel.send(`User <@${uid}> has reached 3 warnings and was auto-blacklisted.`); } catch {}
        const thId = userToThread.get(uid);
        if (thId) { const ch = await client.channels.fetch(thId).catch(() => null); if (inForumThread(ch)) await ch.send('Note: User auto-blacklisted after 3 warnings.').catch(() => {}); }
      }
      return;
    }

    if (cmd === 'dm') {
      const uid = parseUser(args.shift());
      const msgText = (args.join(' ') || '').trim();
      if (!uid || !msgText) return;
      try {
        const user = await client.users.fetch(uid);
        await user.send({ content: msgText });
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
      let uid = threadToUser.get(ch.id);
      if (!uid) { const m = ch.name?.match(/[(\d{17,20})]$/); if (m) { uid = m[1]; threadToUser.set(ch.id, uid); userToThread.set(uid, ch.id); } }
      if (!uid) return;
      const reason = args.join(' ').trim() || 'No reason provided';
      try { const user = await client.users.fetch(uid); await user.send(`**Staff**: Your ModMail ticket has been closed. Reason: ${reason}`); } catch {}
      try { await ch.send(`Closing thread. Reason: ${reason}`); } catch {}
      try { await ch.setArchived(true, `Closed by ${message.author.tag}: ${reason}`); } catch {}
      userToThread.delete(uid); threadToUser.delete(ch.id);
      return;
    }

    return;
  }

  const ch = message.channel;
  if (!inForumThread(ch)) return;
  let uid = threadToUser.get(ch.id);
  if (!uid) { const m = ch.name?.match(/[(\d{17,20})]$/); if (m) { uid = m[1]; threadToUser.set(ch.id, uid); userToThread.set(uid, ch.id); } }
  if (!uid) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  const staff = !!member && (
    member.permissions.has(PermissionFlagsBits.ManageThreads) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
  if (!staff) return;

  const user = await client.users.fetch(uid).catch(() => null);
  if (!user) return;
  await forwardStaffToUser(message, user);
});

client.login(DISCORD_TOKEN);
