const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ Missing environment variables: TOKEN, SUPABASE_URL, SUPABASE_KEY");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// In-memory join order per guild (resets on bot restart)
const joinOrder = {}; // guildId -> Map<userId, true>

client.once('clientReady', async c => {
    console.log(`Logged in as ${c.user.tag}`);

    // Register slash command for all guilds
    const commands = [
        new SlashCommandBuilder()
            .setName("setchannels")
            .setDescription("Set voice, text, and log channels for this server")
            .addChannelOption(opt => opt.setName("voice").setDescription("Voice channel to track").setRequired(true))
            .addChannelOption(opt => opt.setName("text").setDescription("Text channel for join order display").setRequired(true))
            .addChannelOption(opt => opt.setName("log").setDescription("Text channel for join logs").setRequired(true))
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    for (const guild of client.guilds.cache.values()) {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
    }

    console.log("✅ /setchannels command registered");
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "setchannels") {
        const guildId = interaction.guild.id;
        const voiceChannel = interaction.options.getChannel("voice");
        const textChannel = interaction.options.getChannel("text");
        const logChannel = interaction.options.getChannel("log");

        // Upsert config into Supabase
        const { error } = await supabase
            .from('guild_config')
            .upsert({
                guild_id: guildId,
                voice_channel_id: voiceChannel.id,
                text_channel_id: textChannel.id,
                log_channel_id: logChannel.id
            }, { onConflict: 'guild_id' });

        if (error) {
            console.error("Supabase error:", error);
            return interaction.reply("❌ Failed to save channels");
        }

        // Initialize in-memory joinOrder
        if (!joinOrder[guildId]) joinOrder[guildId] = new Map();

        await interaction.reply(`✅ Channels set:\nVoice: ${voiceChannel}\nText: ${textChannel}\nLog: ${logChannel}`);
    }
});

// Helper: get guild config from Supabase
async function getGuildConfig(guildId) {
    const { data, error } = await supabase
        .from('guild_config')
        .select('*')
        .eq('guild_id', guildId)
        .single();

    if (error || !data) return null;
    return data;
}

// Update join order display
async function updateDisplay(guildId) {
    const config = await getGuildConfig(guildId);
    if (!config) return;

    const textChannel = await client.channels.fetch(config.text_channel_id);
    let displayMessage;

    const messages = await textChannel.messages.fetch({ limit: 10 });
    displayMessage = messages.find(m => m.author.id === client.user.id);
    if (!displayMessage) {
        displayMessage = await textChannel.send("🔊 **Voice Join Order**\nWaiting for members...");
    }

    const map = joinOrder[guildId] || new Map();
    const vcChannel = await client.channels.fetch(config.voice_channel_id);
    const membersInVC = vcChannel.members.map(m => m.id);

    const filteredOrder = Array.from(map.keys()).filter(id => membersInVC.includes(id));

    const text = filteredOrder.length > 0
        ? `🔊 **Voice Join Order**\n${filteredOrder.map((id, i) => `${i + 1}. <@${id}>`).join("\n")}`
        : "🔊 **Voice Join Order**\nNo one is in the channel.";

    await displayMessage.edit(text);
}

// Voice state update
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const guildId = newState.guild.id;
        const config = await getGuildConfig(guildId);
        if (!config) return;

        const userId = newState.id;
        const newChannel = newState.channelId;

        if (!joinOrder[guildId]) joinOrder[guildId] = new Map();

        if (newChannel === config.voice_channel_id && !joinOrder[guildId].has(userId)) {
            joinOrder[guildId].set(userId, true);

            const logChannel = await client.channels.fetch(config.log_channel_id);
            logChannel.send(`${newState.member.user.tag} JOINED`);
        }

        updateDisplay(guildId);

    } catch (err) {
        console.error("Error in voiceStateUpdate:", err);
    }
});

client.login(TOKEN);
