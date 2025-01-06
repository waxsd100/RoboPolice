module.exports = {
	func: async (message, suffix) => {
		let DMC;
		try {
			DMC = await message.author.getDMChannel();
		} catch (e) {
			message.channel
				.createMessage(`<@${message.author.id}>, you're not capable of receiving a DM from me.`)
				.catch(() => {});
			return;
		}

		if (suffix) {
			if (!global.bot.commands[suffix] || global.bot.commands[suffix]?.hidden) {
				return message.channel.createMessage(
					`<@${message.author.id}>, that isn't a valid command. Use \`${process.env.GLOBAL_BOT_PREFIX}help\` to see all commands.`,
				);
			}
			await message.channel.createMessage({
				embeds: [
					{
						title: `Help for ${suffix}`,
						description: global.bot.commands[suffix].quickHelp,
						fields: [
							{
								name: 'Examples',
								value: global.bot.commands[suffix].examples,
							},
						],
						color: 0xffffff,
					},
				],
			});
		} else {
			const embed = {
				description: `Below, you can see my commands listed by name and description. To learn more about a command or view examples, use ${process.env.GLOBAL_BOT_PREFIX}help commandname.`,
				color: 3553599,
				timestamp: new Date(),
				footer: {
					icon_url: global.bot.user.avatarURL,
					text: `${global.bot.user.username}#${global.bot.user.discriminator}`,
				},
				thumbnail: {
					url: global.bot.user.avatarURL,
				},
				author: {
					name: `${message.author.username}#${message.author.discriminator}`,
					icon_url: message.author.avatarURL,
				},
				fields: [],
			};
			Object.values(global.bot.commands).forEach((command) => {
				if (!command.hidden) {
					embed.fields.push({
						name: command.name,
						value: `${command.quickHelp}\n\nExample(s):\n${command.examples}`,
					});
				}
			});
			try {
				await DMC.createMessage({
					embeds: [embed],
				});
				await message.addReaction('📜');
			} catch (_) {
				message.addReaction('❌').catch(() => {});
				message.channel
					.createMessage(
						`<@${message.author.id}>, I can't send you a help DM! Open your DMs to fix this or use \`${process.env.GLOBAL_BOT_PREFIX}help commandname\``,
					)
					.catch(() => {});
			}
		}
	},
	name: 'help',
	quickHelp: 'DM you with a help message!',
	examples: `\`${process.env.GLOBAL_BOT_PREFIX}help\` <- DM a help message with every command
  \`${process.env.GLOBAL_BOT_PREFIX}help setchannel\` <- get further info (examples) on any command`,
	type: 'any',
	category: 'General',
};
