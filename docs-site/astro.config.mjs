// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.longlines.io',
	integrations: [
		starlight({
			title: 'Long Lines',
			description: 'How to use Long Lines and Long Lines Relay.',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sonyccd/longlines' }],
			sidebar: [{ label: 'Getting started', slug: 'getting-started' }],
			// The web app's palette and font (MUI's stock theme) on Starlight's theme variables.
			customCss: [
				'@fontsource/roboto/400.css',
				'@fontsource/roboto/500.css',
				'@fontsource/roboto/700.css',
				'./src/styles/theme.css',
			],
			// Same browser bar colors as the web app's index.html.
			head: [
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
