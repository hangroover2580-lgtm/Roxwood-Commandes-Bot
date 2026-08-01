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
  archiveChannelId: process.env.ARCHIVE_CHANNEL_ID?.trim() || '',
  patchNotesChannelId: process.env.PATCH_NOTES_CHANNEL_ID?.trim() || '',
  appsScriptCallbackUrl:
    process.env.APPS_SCRIPT_CALLBACK_URL?.trim().replace(/\/+$/, '') || '',
  appsScriptCallbackSecret:
    process.env.APPS_SCRIPT_CALLBACK_SECRET?.trim() || '',
  companyName: process.env.COMPANY_NAME?.trim() || 'Roxwood Pizzeria',
  brandColor: Number.parseInt(
    process.env.BRAND_COLOR?.replace('#', '') || 'B51F24',
    16,
  ),
  logoUrl: process.env.BRAND_LOGO_URL?.trim() || '',
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

function buildButtons(orderNumber, status = 'waiting', employeeId = '') {
  const terminal = ['completed', 'cancelled'].includes(status);
  const suffix = employeeId ? `:${employeeId}` : '';

  const claim = new ButtonBuilder()
    .setCustomId(`order:claim:${orderNumber}${suffix}`)
    .setLabel('Prendre en charge')
    .setEmoji('👨‍🍳')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(status !== 'waiting');

  const preparing = new ButtonBuilder()
    .setCustomId(`order:preparing:${orderNumber}${suffix}`)
    .setLabel('En préparation')
    .setEmoji('🍳')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!['claimed', 'preparing'].includes(status) || terminal);

  const delivery = new ButtonBuilder()
    .setCustomId(`order:delivery:${orderNumber}${suffix}`)
    .setLabel('En livraison')
    .setEmoji('🚗')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!['claimed', 'preparing', 'delivery'].includes(status) || terminal);

  const completed = new ButtonBuilder()
    .setCustomId(`order:completed:${orderNumber}${suffix}`)
    .setLabel('Effectuée')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success)
    .setDisabled(!['claimed', 'preparing', 'delivery'].includes(status) || terminal);

  const cancelled = new ButtonBuilder()
    .setCustomId(`order:cancelled:${orderNumber}${suffix}`)
    .setLabel('Annuler')
    .setEmoji('✖️')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(terminal);

  return [
    new ActionRowBuilder().addComponents(
      claim,
      preparing,
      delivery,
      completed,
      cancelled,
    ),
  ];
}

function brandAuthor() {
  const author = { name: config.companyName };
  if (config.logoUrl) author.iconURL = config.logoUrl;
  return author;
}

function cleanLines(value, maxLines = 16) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-•✨🔧🚀]\s*/, ''))
    .filter(Boolean)
    .slice(0, maxLines);
}

function bulletList(value, fallback = 'Aucun élément renseigné.') {
  const lines = cleanLines(value);
  return lines.length ? lines.map((line) => `• ${line}`).join('\n') : fallback;
}

function safeField(value, fallback = 'Non renseigné', max = 1024) {
  return cleanText(value, fallback, max);
}

function buildOrderEmbed(order) {
  const items = cleanItems(order.items);
  const itemsText = items.length
    ? items
        .slice(0, 20)
        .map(
          (item) =>
            `**${item.quantity} × ${item.name}** — ${formatMoney(
              item.quantity * item.price,
            )}`,
        )
        .join('\n')
        .slice(0, 3900)
    : 'Aucun article renseigné.';

  const isProfessional = order.customerType === 'professional';

  const embed = new EmbedBuilder()
    .setAuthor(brandAuthor())
    .setTitle(`🍕 Commande ${cleanText(order.orderNumber, 'Inconnue', 60)}`)
    .setDescription(`### Détail de la commande\n${itemsText}`)
    .setColor(config.brandColor)
    .addFields(
      {
        name: '🧾 Informations',
        value:
          `**Type :** ${
            isProfessional ? 'Entreprise' : 'Citoyen'
          }\n` +
          (isProfessional
            ? `**Entreprise :** ${safeField(order.companyName)}\n`
            : '') +
          `**Montant :** ${formatMoney(order.total)}`,
        inline: true,
      },
      {
        name: '👤 Client',
        value:
          `**Nom :** ${safeField(order.customerName)}\n` +
          `**Discord :** ${safeField(order.discordUsername)}\n` +
          `**Téléphone RP :** ${safeField(order.phone)}`,
        inline: true,
      },
      {
        name: '📦 Retrait / livraison',
        value:
          `**Mode :** ${safeField(order.orderType)}\n` +
          `**Prévu le :** ${safeField(order.requestedDate)} à ` +
          `${safeField(order.requestedTime)}\n` +
          `**Adresse RP :** ${safeField(order.address)}`,
        inline: false,
      },
      {
        name: '📍 Suivi de la commande',
        value:
          '**Statut :** En attente de prise en charge\n' +
          '**Employé :** Aucun',
        inline: false,
      },
    )
    .setFooter({
      text: `${config.companyName} • Gestion des commandes`,
    })
    .setTimestamp();

  const notes = cleanText(order.notes, '', 900);
  if (notes) {
    embed.addFields({
      name: '💬 Commentaire du client',
      value: notes,
      inline: false,
    });
  }

  if (config.logoUrl) embed.setThumbnail(config.logoUrl);
  return embed;
}
function getFieldValue(embed, fieldName) {
  return embed.fields?.find((entry) => entry.name === fieldName)?.value || '';
}


function getOrderDataFromEmbed(embed) {
  const information = getFieldValue(embed, '🧾 Informations');
  const client = getFieldValue(embed, '👤 Client');
  const delivery = getFieldValue(embed, '📦 Retrait / livraison');
  const tracking = getFieldValue(embed, '📍 Suivi de la commande');

  const read = (text, label) => {
    const pattern = new RegExp(
      `\\*\\*${label} :\\*\\*\\s*([^\\n]+)`,
      'i',
    );
    return String(text || '').match(pattern)?.[1]?.trim() || '';
  };

  const planned = read(delivery, 'Prévu le');

  return {
    type: read(information, 'Type'),
    company: read(information, 'Entreprise'),
    total: read(information, 'Montant'),
    customer: read(client, 'Nom'),
    discord: read(client, 'Discord'),
    phone: read(client, 'Téléphone RP'),
    mode: read(delivery, 'Mode'),
    date: planned.split(' à ')[0] || '',
    time: planned.split(' à ')[1] || '',
    address: read(delivery, 'Adresse RP'),
    status: read(tracking, 'Statut'),
    employee: read(tracking, 'Employé'),
  };
}

function updateTrackingField(embed, status, employeeName) {
  replaceField(
    embed,
    '📍 Suivi de la commande',
    `**Statut :** ${status}\n**Employé :** ${employeeName}`,
    false,
  );
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
  const data = getOrderDataFromEmbed(embed);
  const value =
    data.status ||
    getFieldValue(embed, 'Suivi') ||
    getFieldValue(embed, '📌 Statut');

  return (
    Object.entries(STATUS).find(([, status]) =>
      String(value).includes(status.label),
    )?.[0] || 'waiting'
  );
}

function getAssignedEmployeeId(interaction) {
  return interaction.customId.split(':')[3] || '';
}

function getEmployeeDisplayName(interaction) {
  return cleanText(
    interaction.member?.displayName ||
      interaction.user.globalName ||
      interaction.user.username,
    'Employé',
    80,
  );
}


function normalizePatchLines(value, prefix) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 20);

  if (lines.length === 0) {
    return '';
  }

  return lines
    .map(line => `${prefix} ${line}`)
    .join('\n')
    .slice(0, 1000);
}

function buildPatchNoteEmbed(patch) {
  const category = cleanText(
    patch.category,
    'Mise à jour générale',
    60,
  );
  const colors = {
    Site: 0x5865f2,
    Bot: 0x2b2d31,
    Comptabilité: 0x2f6b42,
    Correctif: 0xd9822b,
    'Mise à jour globale': config.brandColor,
  };

  const embed = new EmbedBuilder()
    .setAuthor(brandAuthor())
    .setTitle(
      `${cleanText(patch.version, 'Nouvelle version', 40)} — ` +
        `${cleanText(patch.title, 'Mise à jour', 120)}`,
    )
    .setDescription(
      `Une nouvelle version de **${config.companyName}** est disponible.`,
    )
    .setColor(colors[category] || config.brandColor)
    .addFields(
      { name: 'Catégorie', value: category, inline: true },
      {
        name: 'Publication',
        value: cleanText(patch.author, 'Administration', 80),
        inline: true,
      },
    )
    .setFooter({
      text: `${config.companyName} • Notes de version officielles`,
    })
    .setTimestamp(
      patch.publishedAt ? new Date(patch.publishedAt) : new Date(),
    );

  for (const [title, content] of [
    ['Nouveautés', patch.newFeatures],
    ['Correctifs', patch.fixes],
    ['Améliorations', patch.improvements],
  ]) {
    if (cleanLines(content).length) {
      embed.addFields({
        name: title,
        value: bulletList(content).slice(0, 1024),
      });
    }
  }

  if (config.logoUrl) embed.setThumbnail(config.logoUrl);
  return embed;
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
    const employeeMention = config.employeeRoleId
      ? `<@&${config.employeeRoleId}>`
      : '';

    const message = await channel.send({
      content: employeeMention
        ? `${employeeMention} 🍕 Une nouvelle commande vient d’arriver.`
        : '🍕 Une nouvelle commande vient d’arriver.',
      embeds: [buildOrderEmbed(request.body)],
      components: buildButtons(orderNumber, 'waiting'),
      allowedMentions: config.employeeRoleId
        ? { roles: [config.employeeRoleId] }
        : { parse: [] },
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


function parseMoneyValue(value) {
  const normalized = String(value || '')
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.');

  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function parseOrderItemsFromEmbed(embed) {
  const description = String(embed.description || '');

  return description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /^\*\*\d+\s+×\s+.+\*\*\s+—\s+/.test(line),
    )
    .map((line) => {
      const match = line.match(
        /^\*\*(\d+)\s+×\s+(.+?)\*\*\s+—\s+(.+)$/,
      );

      if (!match) return null;

      const quantity = Math.max(1, Number(match[1]) || 1);
      const lineTotal = parseMoneyValue(match[3]);

      return {
        name: cleanText(match[2], 'Produit', 100),
        quantity,
        price: lineTotal / quantity,
        lineTotal,
      };
    })
    .filter(Boolean);
}

function extractOrderNumber(embed) {
  const title = String(
    embed?.data?.title ||
    embed?.title ||
    ''
  );

  const match = title.match(
    /Commande\s+#?([A-Za-z0-9_-]+)/i,
  );

  return match?.[1]?.trim() || '';
}

async function syncCompletedOrderToAccounting(interaction, embed, employeeName) {
  if (!config.appsScriptCallbackUrl || !config.appsScriptCallbackSecret) {
    throw new Error(
      'La connexion à la comptabilité n’est pas configurée dans Railway.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  const data = getOrderDataFromEmbed(embed);
  const orderNumber = extractOrderNumber(embed);

  if (!orderNumber) {
    throw new Error(
      'Numéro de commande introuvable dans le message Discord.',
    );
  }

  const payload = {
    action: 'complete_order',
    secret: config.appsScriptCallbackSecret,
    order: {
      orderNumber,
      completedAt: new Date().toISOString(),
      customerType:
        data.type || getFieldValue(embed, '🏷️ Type'),
      companyName:
        data.company || getFieldValue(embed, '🏢 Entreprise'),
      customerName:
        data.customer || getFieldValue(embed, '👤 Client'),
      discordUsername:
        data.discord || getFieldValue(embed, '💬 Discord'),
      phone:
        data.phone || getFieldValue(embed, '📞 Téléphone RP'),
      orderType:
        data.mode || getFieldValue(embed, '📦 Mode'),
      requestedDate:
        data.date || getFieldValue(embed, '📅 Date souhaitée'),
      requestedTime:
        data.time || getFieldValue(embed, '🕒 Heure souhaitée'),
      address:
        data.address || getFieldValue(embed, '📍 Adresse RP'),
      employeeName,
      total: parseMoneyValue(
        data.total || getFieldValue(embed, '💵 Total'),
      ),
      notes:
        getFieldValue(embed, '💬 Commentaire du client') ||
        getFieldValue(embed, '📝 Commentaire'),
      items: parseOrderItemsFromEmbed(embed),
      discordMessageId: interaction.message.id,
      discordChannelId: interaction.channelId,
    },
  };

  try {
    const response = await fetch(config.appsScriptCallbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await response.text();
    let result = {};

    try {
      result = JSON.parse(responseText);
    } catch {
      result = {};
    }

    if (!response.ok || result.ok !== true) {
      throw new Error(
        result.error ||
          `La comptabilité a refusé la commande (HTTP ${response.status}).`,
      );
    }

    return result;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(
        'La comptabilité n’a pas répondu dans le délai prévu.',
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function archiveCompletedOrder(interaction, embed) {
  if (!config.archiveChannelId) {
    console.warn(
      'ARCHIVE_CHANNEL_ID non configuré : la commande terminée reste dans le salon actuel.',
    );
    return false;
  }

  const archiveChannel = await client.channels.fetch(config.archiveChannelId);

  if (!archiveChannel?.isTextBased()) {
    throw new Error('Le salon d’archives est introuvable ou invalide.');
  }

  const archivedEmbed = EmbedBuilder.from(embed)
    .setAuthor(brandAuthor())
    .setTitle(`${String(embed.data.title || 'Commande').replace(/^🍕\s*/, '')} — Terminée`)
    .setColor(0x2f6b42)
    .setFooter({
      text: `${config.companyName} • Archive des commandes`,
    })
    .setTimestamp();

  replaceField(
    archivedEmbed,
    '📁 Archivage',
    `Commande archivée le ${new Date().toLocaleString('fr-FR', {
      timeZone: 'Europe/Paris',
    })}`,
    false,
  );

  await archiveChannel.send({
    content: '✅ Commande terminée et archivée.',
    embeds: [archivedEmbed],
    allowedMentions: { parse: [] },
  });

  await interaction.message.delete();
  return true;
}


app.post('/api/patch-notes', async (request, response) => {
  try {
    if ((request.get('authorization') || '') !== `Bearer ${config.apiSecret}`) {
      return response.status(401).json({
        ok: false,
        error: 'Accès refusé.',
      });
    }

    if (!config.patchNotesChannelId) {
      return response.status(500).json({
        ok: false,
        error: 'PATCH_NOTES_CHANNEL_ID n’est pas configuré.',
      });
    }

    if (!client.isReady()) {
      return response.status(503).json({
        ok: false,
        error: 'Le bot Discord n’est pas encore prêt.',
      });
    }

    const version = cleanText(request.body?.version, '', 40);
    const title = cleanText(request.body?.title, '', 120);

    if (!version || !title) {
      return response.status(400).json({
        ok: false,
        error: 'La version et le titre sont obligatoires.',
      });
    }

    const channel = await client.channels.fetch(config.patchNotesChannelId);

    if (!channel?.isTextBased()) {
      return response.status(500).json({
        ok: false,
        error: 'Le salon de patch notes est introuvable.',
      });
    }

    const message = await channel.send({
      embeds: [buildPatchNoteEmbed(request.body)],
      allowedMentions: { parse: [] },
    });

    return response.status(201).json({
      ok: true,
      messageId: message.id,
      patchId: cleanText(request.body?.patchId, '', 80),
    });
  } catch (error) {
    console.error('Erreur publication patch note :', error);

    return response.status(500).json({
      ok: false,
      error: 'Erreur interne lors de la publication de la patch note.',
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
    const assignedEmployeeId = getAssignedEmployeeId(interaction);

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
        content: 'Cette commande est déjà prise en charge par un autre employé.',
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
    const employeeId = assignedEmployeeId || interaction.user.id;
    const employeeName = getEmployeeDisplayName(interaction);

    updateTrackingField(embed, nextStatus.label, employeeName);
    replaceField(
      embed,
      '🕒 Dernière mise à jour',
      `${nextStatus.emoji} **${nextStatus.label}** par ${employeeName}`,
      false,
    );

    embed.setFooter({
      text: `${config.companyName} • Gestion des commandes`,
    });

    if (nextStatusKey === 'completed') {
      await interaction.deferUpdate();

      try {
        await syncCompletedOrderToAccounting(
          interaction,
          embed,
          employeeName,
        );
      } catch (accountingError) {
        console.error(
          'Erreur synchronisation comptabilité :',
          accountingError,
        );

        await interaction.followUp({
          content:
            `❌ Impossible de terminer la commande : ${accountingError.message}\n` +
            'La commande reste dans le salon de gestion afin de ne pas perdre la recette.',
          ephemeral: true,
        });

        return;
      }

      await interaction.editReply({
        embeds: [embed],
        components: buildButtons(orderNumber, nextStatusKey, employeeId),
        allowedMentions: { parse: [] },
      });

      try {
        await archiveCompletedOrder(interaction, embed);
      } catch (archiveError) {
        console.error('Erreur archivage commande :', archiveError);

        await interaction.followUp({
          content:
            '⚠️ La recette a bien été enregistrée, mais l’archivage Discord a échoué. Vérifie le salon d’archives et les permissions du bot.',
          ephemeral: true,
        });
      }

      return;
    }

    await interaction.update({
      embeds: [embed],
      components: buildButtons(orderNumber, nextStatusKey, employeeId),
      allowedMentions: { parse: [] },
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
