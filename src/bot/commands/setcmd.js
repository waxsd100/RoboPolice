const ERIS_CONSTANTS = require('eris').Constants;

module.exports = {
	func: async (message, suffix) => {
		const commands = [
			{
				name: 'ping',
				description: 'Проверка работоспобности бота',
			},
			{
				name: 'setup',
				description: 'Настройка логгера',
				options: [
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.SUB_COMMAND,
						name: 'via_presets',
						description: 'Настройка с помощью пресетов',
					},
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.SUB_COMMAND,
						name: 'via_individual_event',
						description: 'Настройка индивидуальных событый',
					},
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.SUB_COMMAND,
						name: 'list',
						description: 'Просмотр настроенк',
					},
				],
			},
			{
				name: 'archive',
				description: 'Сохраняет сообщение в канале и публикет их для просмотра онлайн',
				options: [
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.INTEGER,
						name: 'amount',
						description: 'Кол-во сообщений (Больше 5 и меньше 100)',
						required: true,
						autocomplete: true,
						max_value: 100,
						min_value: 5,
					},
				],
			},
			{
				name: 'ignorechannel',
				description: 'Игнор выбраного канала',
				options: [
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.CHANNEL,
						name: 'channel-to-ignore',
						description: 'Канал в котором не будут работать логи',
						channel_types: [0, 2, 4], // text, voice, category
					},
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
						name: 'optional',
						description: 'Доп. информация',
						choices: [
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'список игнор каналов',
								value: 'list',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'сбросить игнор каналы',
								value: 'reset',
							},
						],
					},
				],
			},
			{
				name: 'stoplogging',
				description: 'Перестать логировать канал или сервер',
				options: [
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.CHANNEL,
						name: 'channel',
						description: 'Stop logging any events in the given channel',
						channel_types: [0, 2, 4], // text, voice, category
					},
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
						name: 'other',
						description: 'Other stoplogging options',
						choices: [
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'stop logging anything anywhere (everything)',
								value: 'everything',
							},
						],
					},
				],
			},
			{
				name: 'logbots',
				description: 'Логировать ли действия других ботов? (Дефолт: НЕТ)',
			},
			{
				name: 'help',
				description: 'Помощь по боту',
				options: [
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
						name: 'event',
						description: 'Get information about a given command',
						choices: [
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Channel Create',
								value: 'channelCreate',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Channel Update',
								value: 'channelUpdate',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Channel Delete',
								value: 'channelDelete',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Member Banned',
								value: 'guildBanAdd',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Member Unbanned',
								value: 'guildBanRemove',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Role Create',
								value: 'guildRoleCreate',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Role Delete',
								value: 'guildRoleDelete',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Role Update',
								value: 'guildRoleUpdate',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Server Settings Change',
								value: 'guildUpdate',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Server Emojis Change',
								value: 'guildEmojisUpdate',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Message Delete',
								value: 'messageDelete',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Bulk Message Delete',
								value: 'messageDeleteBulk',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Message Edit',
								value: 'messageUpdate',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Member Join',
								value: 'guildMemberAdd',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Member Kick',
								value: 'guildMemberKick',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Member Leave',
								value: 'guildMemberRemove',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Member Nickname Update',
								value: 'guildMemberNickUpdate',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Member Role Add/Remove',
								value: 'guildMemberUpdate',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Member Gate Verify',
								value: 'guildMemberVerify',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Voice Channel Leave',
								value: 'voiceChannelLeave',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Voice Channel Join',
								value: 'voiceChannelJoin',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Voice Channel Moved',
								value: 'voiceChannelSwitch',
							},
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Member Voice Muted/Deafened',
								value: 'voiceStateUpdate',
							},
						],
					},
					{
						type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
						name: 'guide',
						description: 'Get information on how to set the bot up',
						choices: [
							{
								type: ERIS_CONSTANTS.ApplicationCommandOptionTypes.STRING,
								name: 'Usage',
								value: 'usage',
							},
						],
					},
				],
			},
		];
		try {
			if (suffix === 'guild') {
				await global.bot.bulkEditGuildCommands(message.channel.guild.id, commands);
				message.channel.createMessage({
					content: 'OK set guild commands',
					messageReference: { messageID: message.id },
				});
				global.logger.info(`Guild set ${commands.length} slash commands successfully`);
			} else if (suffix === 'global') {
				await global.bot.bulkEditCommands(commands);
				message.channel.createMessage({
					content: 'OK set global commands',
					messageReference: { messageID: message.id },
				});
				global.logger.info(`Globally set ${commands.length} slash commands successfully`);
			} else {
				message.channel.createMessage({
					content: 'Incorrect usage, options are guild or global.',
					messageReference: { messageID: message.id },
				});
			}
		} catch (e) {
			global.logger.error('Error setting guild slash commands', e);
			message.channel.createMessage({
				content: 'Error setting slash commands',
				messageReference: { messageID: message.id },
			});
		}
	},
	name: 'setcmd',
	description: 'Bot owner debug command.',
	type: 'creator',
	hidden: true,
};
