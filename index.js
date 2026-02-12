import 'dotenv/config';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, Client, EmbedBuilder, Events,
  GatewayIntentBits, Partials, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle,
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
const userToThread = new Map();     // userId -> threadId
const threadToUser = new Map();     // threadId -> userId
const blacklist = new Set();        // userIds
const lastDMRelayAt = new Map();    // userId -> timestamp
const warnData = new Map();         // userId -> warn entries
const closedThreads = new Set();    // threadIds
const activeAppeals = new Map();    // userId -> appealThreadId

// Utility: convert message attachments to FileOptions, re-uploading when possible
async function attachmentsToFiles(attachments) {
  const files = [];
  for (const att of attachments.values()) {
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`Failed to fetch ${att.url}: ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      files.push({ attachment: data, name: att.name || 'file' });
    } catch {
      files.push({ attachment: att.url, name: att.name || 'file' });
    }
  }
  return files;
}

const ids = {
  yes: (u) => `mm_yes_${u}`,
  no: (u) => `mm_no_${u}`,
  appealBtn: (u) => `mm_appeal_${u}`,
  appealModal: (u) => `mm_modal_${u}`,
  staffAccept: (th) => `mm_accept_${th}`,
  staffDeny: (th) => `mm_deny_${th}`,
};

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

// Red Appeal button row
const appealRow = (u, disabled = false) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ids.appealBtn(u))
      .setLabel('Appeal')
      .setStyle(ButtonStyle.Danger) // red button
      .setDisabled(disabled),
  );

// Staff decision buttons on appeal thread
const staffDecisionRow = (threadId) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ids.staffAccept(threadId)).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ids.staffDeny(threadId)).setLabel('Deny').setStyle(ButtonStyle.Danger),
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
  const text = dm.content?.trim();
  const files = await attachmentsToFiles(dm.attachments);
  if (!text && files.length === 0) return;
  await thread.send({
    content: `**<@${dm.author.id}>**:${text ? ` ${text}` : ''}`,
    files: files.length ? files : undefined,
  });
  await addSuccessReaction(dm);
}

async function forwardStaffToUser(msg, user) {
  const text = msg.content?.trim();
  const files = await attachmentsToFiles(msg.attachments);
  if (!text && files.length === 0) return;
  await user.send({
    content: `**Staff**:${text ? ` ${text}` : ''}`,
    files: files.length ? files : undefined,
  });
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
  try {
    client.user.setActivity('DMs', { type: 3 });
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
    // Blacklisted: send blacklist embed with Appeal button
    const alreadyAppealing = activeAppeals.has(uid);
    await message.channel.send({
      embeds: [embed.blacklist()],
      components: [appealRow(uid, alreadyAppealing)],
    }).catch(() => {});
    return;
  }

  // Normal flow (non-blacklisted)
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

// Handle interactions: buttons + modals
client.on(Events.InteractionCreate, async (i) => {
  try {
    // Appeal button pressed (user)
    if (i.isButton() && i.customId.startsWith('mm_appeal_')) {
      const uid = i.user?.id;
      if (!uid) return;
      if (i.customId !== ids.appealBtn(uid)) return; // ensure only their own button

      if (!blacklist.has(uid)) {
        await i.reply({ content: 'You are not blacklisted.', ephemeral: true }).catch(() => {});
        return;
      }
      if (activeAppeals.has(uid)) {
        await i.reply({ content: 'You already have an open appeal. Please wait for staff to review it.', ephemeral: true }).catch(() => {});
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(ids.appealModal(uid))
        .setTitle('Blacklist Appeal');

      const q1 = new TextInputBuilder()
        .setCustomId('q1')
        .setLabel('Why are you appealing?')
        .setPlaceholder('Explain your reason for appealing...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      const q2 = new TextInputBuilder()
        .setCustomId('q2')
        .setLabel('Why should we accept your appeal?')
        .setPlaceholder('Tell us why the appeal should be accepted...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      const q3 = new TextInputBuilder()
        .setCustomId('q3')
        .setLabel('Will you do that again?')
        .setPlaceholder('Be honest and specific.')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(200);

      const row1 = new ActionRowBuilder().addComponents(q1);
      const row2 = new ActionRowBuilder().addComponents(q2);
      const row3 = new ActionRowBuilder().addComponents(q3);

      await i.showModal(modal.addComponents(row1, row2, row3));
      return;
    }

    // Appeal modal submission
    if (i.isModalSubmit() && i.customId.startsWith('mm_modal_')) {
      const uid = i.user?.id;
      if (!uid) return;
      if (i.customId !== ids.appealModal(uid)) return;

      if (!blacklist.has(uid)) {
        await i.reply({ content: 'You are not blacklisted.', ephemeral: true }).catch(() => {});
        return;
      }
      if (activeAppeals.has(uid)) {
        await i.reply({ content: 'You already have an open appeal. Please wait for staff to review it.', ephemeral: true }).catch(() => {});
        return;
      }

      const a1 = i.fields.getTextInputValue('q1')?.trim() || '(no answer)';
      const a2 = i.fields.getTextInputValue('q2')?.trim() || '(no answer)';
      const a3 = i.fields.getTextInputValue('q3')?.trim() || '(no answer)';

      // Create appeal ModMail thread in forum
      const guild = await client.guilds.fetch(GUILD_ID);
      const forum = await guild.channels.fetch(FORUM_CHANNEL_ID);
      if (!forum || forum.type !== ChannelType.GuildForum) {
        await i.reply({ content: 'Configuration error: Forum channel not found.', ephemeral: true }).catch(() => {});
        return;
      }

      const thread = await forum.threads.create({
        name: `Blacklist Appeal - user [${uid}]`,
        message: { content: `Blacklist appeal submitted by <@${uid}>.` },
      });

      // Track active appeal
      activeAppeals.set(uid, thread.id);

      // Post the appeal details + staff controls
      const appealEmbed = new EmbedBuilder()
        .setTitle('Blacklist Appeal')
        .setColor(0xff3b30)
        .setDescription(
          [
            `User: <@${uid}> (${uid})`,
            '',
            `Q1: Why are you appealing?`,
            `• ${a1}`,
            '',
            `Q2: Why should we accept your appeal?`,
            `• ${a2}`,
            '',
            `Q3: Will you do that again?`,
            `• ${a3}`,
          ].join('\n')
        );

      await thread.send({
        embeds: [appealEmbed],
        components: [staffDecisionRow(thread.id)],
      });

      await i.reply({ content: 'Your appeal has been submitted to staff. Please wait for a decision.', ephemeral: true }).catch(() => {});
      return;
    }

    // Staff decision buttons on appeal thread
    if (i.isButton() && (i.customId.startsWith('mm_accept_') || i.customId.startsWith('mm_deny_'))) {
      const member = i.guild ? await i.guild.members.fetch(i.user.id).catch(() => null) : null;
      const staff = !!member && (
        member.permissions.has(PermissionFlagsBits.ManageThreads) ||
        member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
        member.permissions.has(PermissionFlagsBits.ManageMessages) ||
        member.permissions.has(PermissionFlagsBits.Administrator)
      );
      if (!staff) {
        await i.reply({ content: 'You do not have permission to act on appeals.', ephemeral: true }).catch(() => {});
        return;
      }

      const threadId = i.customId.replace(/^mm_(accept|deny)_/, '');
      const ch = await client.channels.fetch(threadId).catch(() => null);
      if (!inForumThread(ch)) {
        await i.reply({ content: 'This appeal thread is no longer valid.', ephemeral: true }).catch(() => {});
        return;
      }

      // Determine user from thread title or mapping
      let uid = threadToUser.get(threadId);
      if (!uid) {
        // Parse from "Blacklist Appeal - user [id]"
        const m = ch.name?.match(/user \[(\d{17,20})\]$/);
        if (m) uid = m[1];
      }
      if (!uid) {
        await i.reply({ content: 'Could not determine the user for this appeal.', ephemeral: true }).catch(() => {});
        return;
      }

      const accept = i.customId.startsWith('mm_accept_');

      if (accept) {
        // Unblacklist and notify
        blacklist.delete(uid);
        try {
          const user = await client.users.fetch(uid);
          await user.send('Your ModMail appeal was accepted and you are unblacklisted!');
        } catch {}
        // Mark appeal resolved
        activeAppeals.delete(uid);

        // Disable buttons and annotate
        const newRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('mm_accept_disabled').setLabel('Accept').setStyle(ButtonStyle.Success).setDisabled(true),
          new ButtonBuilder().setCustomId('mm_deny_disabled').setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(true),
        );
        await i.update({ content: 'Appeal accepted.', components: [newRow] }).catch(() => {});
        try { await ch.send(`Appeal accepted by <@${i.user.id}>. User <@${uid}> unblacklisted.`); } catch {}

      } else {
        // Deny and notify
        try {
          const user = await client.users.fetch(uid);
          await user.send('Unfortunately, your appeal was **denied**, you are welcome to make another appeal.');
        } catch {}
        // Mark appeal resolved (allows resubmission later)
        activeAppeals.delete(uid);

        // Disable buttons and annotate
        const newRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('mm_accept_disabled').setLabel('Accept').setStyle(ButtonStyle.Success).setDisabled(true),
          new ButtonBuilder().setCustomId('mm_deny_disabled').setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(true),
        );
        await i.update({ content: 'Appeal denied.', components: [newRow] }).catch(() => {});
        try { await ch.send(`Appeal denied by <@${i.user.id}>.`); } catch {}
      }

      return;
    }

    // Existing confirmation buttons
    if (i.isButton()) {
      const u = i.user?.id; if (!u) return;
      const isYes = i.customId === ids.yes(u), isNo = i.customId === ids.no(u);
      if (!isYes && !isNo) return;

      if (blacklist.has(u)) {
        await i.update({
          embeds: [embed.blacklist()],
          components: [appealRow(u, activeAppeals.has(u))],
        });
        return;
      }
      if (isNo) {
        await i.update({ content: 'Okay! If you need help later, just message me again.', embeds: [], components: [] });
        return;
      }

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
      return;
    }
  } catch (err) {
    try { if (i.isRepliable()) await i.reply({ content: 'An error occurred handling this interaction.', ephemeral: true }); } catch {}
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
            `• ${PREFIX}dm <user|id> <message> (supports attachments)`,
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
      if (!uid) return;
      if (!msgText && message.attachments.size === 0) {
        await message.reply('Provide a message or attach a file to send.').catch(() => {});
        return;
      }
      try {
        const user = await client.users.fetch(uid);
        const files = await attachmentsToFiles(message.attachments);
        await user.send({
          content: msgText || undefined,
          files: files.length ? files : undefined,
        });
        await addSuccessReaction(message);
        await message.reply(`DM sent to <@${uid}>.${files.length ? ` (${files.length} attachment${files.length === 1 ? '' : 's'})` : ''}`).catch(() => {});
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

  // Staff replies inside ModMail threads relay to the user
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
