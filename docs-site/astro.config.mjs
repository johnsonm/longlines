// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.longlines.io',
	// No landing page: the root opens Getting started.
	redirects: { '/': '/getting-started/' },
	integrations: [
		starlight({
			title: 'Long Lines',
			description: 'How to use Long Lines and Long Lines Relay.',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sonyccd/longlines' }],
			sidebar: [
				{ label: 'Getting started', slug: 'getting-started' },
				{ label: 'Your account', slug: 'account' },
				{
					label: 'Spots in',
					items: [
						{ label: 'Sources', slug: 'sources' },
					],
				},
				{
					label: 'Long Lines Relay',
					items: [
						{ label: 'Overview and sign-in', slug: 'relay' },
						{ label: 'Install', slug: 'relay/install' },
						{ label: 'Set up your logging software', slug: 'relay/loggers' },
						{ label: 'The relay window', slug: 'relay/window' },
						{ label: 'DX cluster', slug: 'relay/dx-cluster' },
					],
				},
				{
					label: 'Connections',
					items: [
						{ label: 'Connections', slug: 'connections' },
						{ label: 'Filter rules', slug: 'filter-rules' },
						{ label: 'Callsign groups', slug: 'callsign-groups' },
						{ label: 'Goals', slug: 'goals' },
					],
				},
				{
					label: 'Destinations',
					items: [
						{ label: 'Overview', slug: 'destinations' },
						{ label: 'Discord channel', slug: 'destinations/discord' },
						{ label: 'Webhook', slug: 'destinations/webhook' },
						{ label: 'Push notifications', slug: 'destinations/push' },
						{ label: 'Local DX cluster', slug: 'destinations/local-dx-cluster' },
					],
				},
				{
					label: 'Look things up',
					items: [
						{ label: 'Band map', slug: 'band-map' },
						{ label: 'Callsign lookup', slug: 'callsign-lookup' },
						{ label: 'Reference lookup', slug: 'reference-lookup' },
						{ label: 'Group statistics', slug: 'group-statistics' },
						{ label: 'Stats', slug: 'stats' },
						{ label: 'Health', slug: 'health' },
					],
				},
				{ label: 'API tokens', slug: 'api-tokens' },
			],
			// The web app's palette and font (MUI's stock theme) on Starlight's theme variables.
			customCss: [
				'@fontsource/roboto/400.css',
				'@fontsource/roboto/500.css',
				'@fontsource/roboto/700.css',
				'./src/styles/theme.css',
			],
			// Same browser bar colors and home screen icon as the web app's index.html.
			head: [
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
				{
					tag: 'meta',
					attrs: { name: 'theme-color', content: '#1976d2', media: '(prefers-color-scheme: light)' },
				},
				{
					tag: 'meta',
					attrs: { name: 'theme-color', content: '#121212', media: '(prefers-color-scheme: dark)' },
				},
			],
		}),
	],
});
