const Eris = require('eris');
const { EMBED_COLORS, ALL_EVENTS, EVENT_HELP } = require('../utils/constants');
const { getEmbedFooter, getAuthorField } = require('../utils/embeds');

module.exports = {
	name: 'help',
	func: async (interaction) => {
		if (!interaction.data.options) {
			interaction
				.createMessage({
					embeds: [
						{
							title: 'General Help',
							description: `**How do I configure ${global.bot.user.username}?**\nSee \`/help guide: Usage\` for a short setup guide.`,
							color: EMBED_COLORS.PURPLED_BLUE,
							thumbnail: {
								url: interaction.member.user.dynamicAvatarURL(null, 64),
							},
							footer: getEmbedFooter(global.bot.user),
						},
					],
					flags: Eris.Constants.MessageFlags.EPHEMERAL,
				})
				.catch(() => {});
		} else if (interaction.data.options?.find((o) => o.name === 'guide')) {
			interaction
				.createMessage({
					embeds: [
						{
							title: 'Usage Guide',
							color: EMBED_COLORS.PURPLED_BLUE,
							description: `**__How does ${global.bot.user.username} work for me?__**\nMost actions on Discord (ban, message edit, member join, etc) are available to be set individually or as a preset to any channel you choose and have \`Manage Webhook\` permissions in.\n\n**__To setup logging__**\nUse \`/setup\` in the text channel you want to have the selected events log to. Select \`via_presets\` (set many events at once - joinlog, messages, ...) or \`via_individual_event\` (configure logging individually). Once all the desired presets or events you want to log to the current channel are selected, close the selection box and the bot will start logging your selection of events. If you want more information about an event, select it using \`/help event\``,
							footer: getEmbedFooter(global.bot.user),
							author: getAuthorField(interaction.member.user),
							thumbnail: {
								url: interaction.member.user.dynamicAvatarURL(null, 64),
							},
						},
					],
					flags: Eris.Constants.MessageFlags.EPHEMERAL,
				})
				.catch(() => {});
		} else if (interaction.data.options?.find((o) => o.name === 'event')) {
			const eventName = interaction.data.options?.find((o) => o.name === 'event').value;
			if (!ALL_EVENTS.includes(eventName)) {
				return;
			}
			interaction.createMessage({
				embeds: [
					{
						title: `Help for ${eventName} event`,
						color: EMBED_COLORS.PURPLED_BLUE,
						footer: getEmbedFooter(global.bot.user),
						author: getAuthorField(interaction.member.user),
						description: `__**Description**__\n${EVENT_HELP[eventName]}`,
					},
				],
				flags: Eris.Constants.MessageFlags.EPHEMERAL,
			});
		}
	},
};
