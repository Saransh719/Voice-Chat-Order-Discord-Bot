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

// In-memory tracking per guild
const joinOrder = {};      // guildId -> array of userIds currently in VC
const joinedOnce = {};     // guildId -> Set of userIds who have ever joined (for logging)

// Bot ready
client.once('clientReady', async c => {
    console.log(`Logged in as ${c.user.tag}`);

    // Register /setchannels command for all guilds
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

    // Initialize join order for members already in voice channels
    for (const guild of client.guilds.cache.values()) {
        const config = await getGuildConfig(guild.id);
        if (!config) continue;

        if (!joinOrder[guild.id]) joinOrder[guild.id] = [];
        if (!joinedOnce[guild.id]) joinedOnce[guild.id] = new Set();

        try {
            const voiceChannel = await guild.channels.fetch(config.voice_channel_id);
            const logChannel = await client.channels.fetch(config.log_channel_id);

            if (voiceChannel && voiceChannel.members) {
                voiceChannel.members.forEach(member => {
                    // Add to join order if not already present
                    if (!joinOrder[guild.id].includes(member.id)) {
                        joinOrder[guild.id].push(member.id);
                    }

                    // Log them if not already logged
                    if (!joinedOnce[guild.id].has(member.id)) {
                        logChannel.send(`${member.user.tag} JOINED`);
                        joinedOnce[guild.id].add(member.id);
                    }
                });

                // Update the display
                updateDisplay(guild.id);
            }
        } catch (err) {
            console.error("Error initializing existing members:", err);
        }
    }
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "setchannels") {
        const guildId = interaction.guild.id;
        const voiceChannel = interaction.options.getChannel("voice");
        const textChannel = interaction.options.getChannel("text");
        const logChannel = interaction.options.getChannel("log");

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

        if (!joinOrder[guildId]) joinOrder[guildId] = [];
        if (!joinedOnce[guildId]) joinedOnce[guildId] = new Set();

        await interaction.reply(`✅ Channels set:\nVoice: ${voiceChannel}\nText: ${textChannel}\nLog: ${logChannel}`);
    }
});

// Helper: fetch guild config
async function getGuildConfig(guildId) {
    const { data, error } = await supabase
        .from('guild_config')
        .select('*')
        .eq('guild_id', guildId)
        .single();

    if (error || !data) return null;
    return data;
}

// Update the join order display
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

    const text = joinOrder[guildId].length > 0
        ? `🔊 **Voice Join Order**\n${joinOrder[guildId].map((id, i) => `${i + 1}. <@${id}>`).join("\n")}`
        : "🔊 **Voice Join Order**\nNo one is in the channel.";

    await displayMessage.edit(text);
}

// Handle voice state updates
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const guildId = newState.guild.id;
        const userId = newState.id;
        const config = await getGuildConfig(guildId);
        if (!config) return;

        if (!joinOrder[guildId]) joinOrder[guildId] = [];
        if (!joinedOnce[guildId]) joinedOnce[guildId] = new Set();

        const oldChannel = oldState.channelId;
        const newChannel = newState.channelId;

        // User joined tracked VC
        if (newChannel === config.voice_channel_id) {
            if (!joinOrder[guildId].includes(userId)) {
                joinOrder[guildId].push(userId);
            }
            if (!joinedOnce[guildId].has(userId)) {
                const logChannel = await client.channels.fetch(config.log_channel_id);
                logChannel.send(`${newState.member.user.tag} JOINED`);
                joinedOnce[guildId].add(userId);
            }
        }

        // User left tracked VC
        if (oldChannel === config.voice_channel_id && newChannel !== config.voice_channel_id) {
            joinOrder[guildId] = joinOrder[guildId].filter(id => id !== userId);
        }

        updateDisplay(guildId);

    } catch (err) {
        console.error("Error in voiceStateUpdate:", err);
    }
});

client.login(TOKEN);
