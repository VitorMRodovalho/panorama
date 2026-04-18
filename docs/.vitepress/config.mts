import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Panorama',
  description: 'Unified open-source platform for IT asset and operational fleet management.',
  outDir: '../dist-docs',
  cleanUrls: true,
  lastUpdated: true,
  // Pre-alpha docs — PT-BR/ES translation stubs intentionally link to
  // files that will exist later. Tighten once the translations land.
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#0b4b3e' }],
  ],

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Docs', link: '/en/architecture' },
          { text: 'ADRs', link: '/adr/0000-index' },
          { text: 'GitHub', link: 'https://github.com/VitorMRodovalho/panorama' },
        ],
        sidebar: {
          '/en/': [
            {
              text: 'Overview',
              items: [
                { text: 'Index', link: '/en/' },
                { text: 'Architecture', link: '/en/architecture' },
                { text: 'Feature matrix', link: '/en/feature-matrix' },
                { text: 'Roadmap', link: '/en/roadmap' },
                { text: 'Dropped features', link: '/en/dropped-features' },
                { text: 'Naming conventions', link: '/en/adr-naming-conventions' },
              ],
            },
            {
              text: 'Operations',
              items: [
                { text: 'Migration from Snipe-IT', link: '/en/migration-from-snipeit' },
                { text: 'Licensing FAQ', link: '/en/licensing' },
                { text: 'Trademark policy', link: '/en/trademark' },
                { text: 'Commercial repo playbook', link: '/en/commercial-repo-playbook' },
              ],
            },
          ],
          '/adr/': [
            {
              text: 'Architecture Decision Records',
              items: [
                { text: 'Index', link: '/adr/0000-index' },
                { text: '0001 — Stack choice', link: '/adr/0001-stack-choice' },
                { text: '0002 — OSS/commercial split', link: '/adr/0002-oss-commercial-split' },
                { text: '0003 — Multi-tenancy', link: '/adr/0003-multi-tenancy' },
                { text: '0004 — Product name', link: '/adr/0004-name' },
                { text: '0005 — Licensing', link: '/adr/0005-licensing' },
                { text: '0006 — Plugin SDK', link: '/adr/0006-plugin-sdk' },
              ],
            },
          ],
        },
      },
    },
    'pt-br': {
      label: 'Português (BR)',
      lang: 'pt-BR',
      link: '/pt-br/',
    },
    es: {
      label: 'Español',
      lang: 'es',
      link: '/es/',
    },
  },

  themeConfig: {
    siteTitle: 'Panorama',
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/VitorMRodovalho/panorama' }],
    footer: {
      message:
        'AGPL-3.0-or-later · <a href="https://github.com/VitorMRodovalho/panorama/blob/main/LICENSE">LICENSE</a>',
      copyright: 'Panorama contributors, 2026+',
    },
    editLink: {
      pattern: 'https://github.com/VitorMRodovalho/panorama/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
});
