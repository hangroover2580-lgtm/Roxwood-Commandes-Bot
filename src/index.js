import express from 'express';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';

const requiredVariables = ['DISCORD_TOKEN', 'ORDERS_CHANNEL_ID', 'API_SECRET'];
const missingVariables = requiredVariables.filter((name) => !process.env[name]?.trim());

if (missingVariables.length > 0) {
  console.error(`Variables Railway manquantes : ${missingVariables.join(', ')}`);
  process.exit(1);
}

const config = {
  token: process.env.DISCORD_TOKEN.trim(),
  ordersChannelId: process.env.ORDERS_CHANNEL_ID.trim(),
  apiSecret: process.env.API_SECRET.trim(),
  employeeRoleId: process.env.EMPLOYEE_ROLE_ID?.trim() || '',
  port: Number(process.env.PORT || 3000),
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '250kb' }));

const STATUS = {
  waiting: { label: 'En attente', emoji: '🕒', color: 0xD8AA55 },
  claimed: { label: 'Prise en charge', emoji: '👨‍🍳', color: 0xE67E22 },
  preparing: { label: 'En préparation', emoji: '🍳', color: 0xF1C40F },
  delivery: { label: 'En livraison', emoji: '🚗', color: 0x3498DB },
  completed: { label: 'Effectuée', emoji: '✅', color: 0x2ECC71 },
  cancelled: { label: 'Annulée', emoji: '❌', color: 0xE74C3C },
};

function cleanText(value, fallback = 'Non renseigné', maxLength = 1000) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  return text.replace(/@/g, '@\u200b').slice(0, maxLength);
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 50).map((item) => ({
    name: cleanText(item?.name, 'Produit', 100),
    quantity: Math.max(1, Math.min(99, Number(item?.quantity) || 1)),
    price: Math.max(0, Number(item?.price) || 0),
  }));
}

function formatMoney(amount) {
  return `${Math.round(Number(amount) || 0).toLocaleString('fr-FR')} $`;
}

function validateOrder(body) {
  if (!body || typeof body !== 'object') return 'Corps de requête invalide.';
  if (!cleanText(body.orderNumber, '', 60)) return 'Numéro de commande manquant.';
  if (cleanItems(body.items).length === 0) return 'La commande ne contient aucun produit.';
  if (cleanText(body.customerName, '', 60).length < 2) return 'Nom du client invalide.';
  return null;
}

function buildButtons(orderNumber, status = 'waiting') {
  const terminal = ['completed', 'cancelled'].includes(status);

  const claim = new ButtonBuilder()
    .setCustomId(`order:claim:${orderNumber}`)
    .setLabel('Prendre en charge')
    .setEmoji('👨‍🍳')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(status !== 'waiting');

  const preparing = new ButtonBuilder()
    .setCustomId(`order:preparing:${orderNumber}`)
    .setLabel('En préparation')
    .setEmoji('🍳')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!['claimed', 'preparing'].includes(status) || terminal);

  const delivery = new ButtonBuilder()
    .setCustomId(`order:delivery:${orderNumber}`)
    .setLabel('En livraison')
    .setEmoji('🚗')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!['claimed', 'preparing', 'delivery'].includes(status) || terminal);

  const completed = new ButtonBuilder()
    .setCustomId(`order:completed:${orderNumber}`)
    .setLabel('Effectuée')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success)
    .setDisabled(!['claimed', 'preparing', 'delivery'].includes(status) || terminal);

  const cancelled = new ButtonBuilder()
    .setCustomId(`order:cancelled:${orderNumber}`)
    .setLabel('Annuler')
    .setEmoji('❌')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(terminal);

  return [new ActionRowBuilder().addComponents(claim, preparing, delivery, completed, cancelled)];
}

function buildOrderEmbed(order) {
  const itemsText = cleanItems(order.items)
    .map((item) => `• **${item.quantity} × ${item.name}** — ${formatMoney(item.quantity * item.price)}`)
    .join('\n')
    .slice(0, 4000);

  const status = STATUS.waiting;

  return new EmbedBuilder()
    .setTitle(`🍕 Commande #${cleanText(order.orderNumber, 'Inconnue', 60)}`)
    .setDescription(itemsText)
    .setColor(status.color)
    .addFields(
      {
        name: '🏷️ Type',
        value: order.customerType === 'professional' ? 'Commande entreprise' : 'Commande citoyen',
        inline: true,
      },
      {
        name: '🏢 Entreprise',
        value: order.customerType === 'professional' ? cleanText(order.companyName) : 'Non concerné',
        inline: true,
      },
      { name: '👤 Client', value: cleanText(order.customerName), inline: true },
      { name: '💬 Discord', value: cleanText(order.discordUsername), inline: true },
      { name: '📞 Téléphone RP', value: cleanText(order.phone), inline: true },
      { name: '📦 Mode', value: cleanText(order.orderType), inline: true },
      { name: '📅 Date souhaitée', value: cleanText(order.requestedDate), inline: true },
      { name: '🕒 Heure souhaitée', value: cleanText(order.requestedTime), inline: true },
      { name: '📍 Adresse RP', value: cleanText(order.address), inline: false },
      { name: '💵 Total', value: `**${formatMoney(order.total)}**`, inline: true },
      { name: '📌 Statut', value: `${status.emoji} ${status.label}`, inline: true },
      { name: '👨‍🍳 Employé', value: 'Aucun', inline: true },
      { name: '📝 Commentaire', value: cleanText(order.notes, 'Aucun commentaire'), inline: false },
    )
    .setFooter({ text: 'Roxwood Pizzeria • Gestion des commandes' })
    .setTimestamp();
}

function getFieldValue(embed, fieldName) {
  return embed.fields?.find((entry) => entry.name === fieldName)?.value || '';
}

function replaceField(embed, name, value, inline = true) {
  const fields = [...(embed.data.fields || [])];
  const index = fields.findIndex((field) => field.name === name);
  const newField = { name, value: cleanText(value, 'Non renseigné', 1000), inline };

  if (index === -1) fields.push(newField);
  else fields[index] = newField;

  embed.setFields(fields);
}

function hasEmployeeAccess(interaction) {
  if (!interaction.inGuild()) return false;

  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return true;
  }

  if (!config.employeeRoleId) return true;
  return Boolean(interaction.member?.roles?.cache?.has(config.employeeRoleId));
}

function getCurrentStatus(embed) {
  const value = getFieldValue(embed, '📌 Statut');
  return Object.entries(STATUS).find(([, status]) => value.includes(status.label))?.[0] || 'waiting';
}

function getAssignedEmployeeId(embed) {
  return getFieldValue(embed, '👨‍🍳 Employé').match(/<@(\d+)>/)?.[1] || '';
}

app.get('/', (_request, response) => {
  response.status(200).json({
    ok: true,
    service: 'Roxwood Commandes',
    discordReady: client.isReady(),
  });
});

app.get('/health', (_request, response) => {
  response.status(client.isReady() ? 200 : 503).json({ ok: client.isReady() });
});

app.post('/api/orders', async (request, response) => {
  try {
    if ((request.get('authorization') || '') !== `Bearer ${config.apiSecret}`) {
      return response.status(401).json({ ok: false, error: 'Accès refusé.' });
    }

    const validationError = validateOrder(request.body);
    if (validationError) {
      return response.status(400).json({ ok: false, error: validationError });
    }

    if (!client.isReady()) {
      return response.status(503).json({ ok: false, error: 'Le bot Discord n’est pas encore prêt.' });
    }

    const channel = await client.channels.fetch(config.ordersChannelId);

    if (!channel?.isTextBased()) {
      return response.status(500).json({ ok: false, error: 'Le salon de commandes est introuvable.' });
    }

    const orderNumber = cleanText(request.body.orderNumber, '', 60);
    const message = await channel.send({
      embeds: [buildOrderEmbed(request.body)],
      components: buildButtons(orderNumber, 'waiting'),
      allowedMentions: { parse: [] },
    });

    return response.status(201).json({
      ok: true,
      messageId: message.id,
      orderNumber,
    });
  } catch (error) {
    console.error('Erreur réception commande :', error);
    return response.status(500).json({
      ok: false,
      error: 'Erreur interne lors de la création de la commande.',
    });
  }
});

client.once('ready', (readyClient) => {
  console.log(`Bot connecté : ${readyClient.user.tag}`);
  readyClient.user.setPresence({
    activities: [{ name: 'les commandes Roxwood 🍕' }],
    status: 'online',
  });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith('order:')) return;

  try {
    if (!hasEmployeeAccess(interaction)) {
      await interaction.reply({
        content: '❌ Tu ne possèdes pas le rôle autorisé pour gérer les commandes.',
        ephemeral: true,
      });
      return;
    }

    const [, action, orderNumber] = interaction.customId.split(':');
    const currentEmbedData = interaction.message.embeds[0];

    if (!currentEmbedData) {
      await interaction.reply({
        content: '❌ Cette commande ne contient pas les données attendues.',
        ephemeral: true,
      });
      return;
    }

    const currentStatus = getCurrentStatus(currentEmbedData);
    const assignedEmployeeId = getAssignedEmployeeId(currentEmbedData);

    if (['completed', 'cancelled'].includes(currentStatus)) {
      await interaction.reply({ content: 'Cette commande est déjà clôturée.', ephemeral: true });
      return;
    }

    if (
      action !== 'claim' &&
      assignedEmployeeId &&
      assignedEmployeeId !== interaction.user.id &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)
    ) {
      await interaction.reply({
        content: `Cette commande est déjà gérée par <@${assignedEmployeeId}>.`,
        ephemeral: true,
      });
      return;
    }

    if (action === 'claim' && currentStatus !== 'waiting') {
      await interaction.reply({
        content: 'Cette commande a déjà été prise en charge.',
        ephemeral: true,
      });
      return;
    }

    const nextStatusKey = {
      claim: 'claimed',
      preparing: 'preparing',
      delivery: 'delivery',
      completed: 'completed',
      cancelled: 'cancelled',
    }[action];

    const nextStatus = STATUS[nextStatusKey];

    if (!nextStatus) {
      await interaction.reply({ content: 'Action inconnue.', ephemeral: true });
      return;
    }

    const embed = EmbedBuilder.from(currentEmbedData).setColor(nextStatus.color);
    replaceField(embed, '📌 Statut', `${nextStatus.emoji} ${nextStatus.label}`, true);
    replaceField(embed, '👨‍🍳 Employé', `<@${assignedEmployeeId || interaction.user.id}>`, true);
    replaceField(
      embed,
      '🕘 Dernière action',
      `${nextStatus.emoji} ${nextStatus.label} par <@${interaction.user.id}>`,
      false,
    );

    await interaction.update({
  embeds: [embed],
  components: buildButtons(orderNumber, nextStatusKey),
  allowedMentions: {
    users: [interaction.user.id],
  },
});
  } catch (error) {
    console.error('Erreur interaction bouton :', error);

    const payload = { content: '❌ Une erreur est survenue.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  }
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Serveur HTTP actif sur le port ${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal} reçu, arrêt en cours...`);
  server.close(async () => {
    await client.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

client.login(config.token).catch((error) => {
  console.error('Connexion Discord impossible :', error);
  process.exit(1);
});
