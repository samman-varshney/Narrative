import { PUBLIC_CRAWLABLE_PATHS, renderRobotsTxt } from '../seo.robots';
import { ROBOTS_DISALLOWED_PATHS } from '../seo.config';
import { overrideEnv, withIndexing } from './helpers';

/**
 * `robots.txt`, and the one mistake this file could make that nobody would
 * notice: disallowing the platform's own content.
 */

let restore: (() => void)[] = [];

beforeEach(() => {
  restore = [
    overrideEnv('APP_URL', 'https://narrative.test'),
    overrideEnv('SEO_SITE_NAME', 'Narrative'),
    overrideEnv('SEO_SITEMAP_BASE_URL', undefined),
  ];
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
});

describe('when indexing is enabled', () => {
  const render = () => withIndexing(true, () => renderRobotsTxt());

  it('opens one group for every crawler', async () => {
    const txt = await render();
    expect(txt.match(/User-agent:/g)).toHaveLength(1);
    expect(txt).toContain('User-agent: *');
  });

  it('advertises the sitemap by absolute URL', async () => {
    expect(await render()).toContain('Sitemap: https://narrative.test/sitemap.xml');
  });

  it('advertises the sitemap on the configured base when the API is elsewhere', async () => {
    const undo = overrideEnv('SEO_SITEMAP_BASE_URL', 'https://api.narrative.test/');
    try {
      expect(await render()).toContain('Sitemap: https://api.narrative.test/sitemap.xml');
    } finally {
      undo();
    }
  });

  it('disallows every internal path', async () => {
    const txt = await render();
    for (const path of ROBOTS_DISALLOWED_PATHS) {
      expect(txt).toContain(`Disallow: ${path}`);
    }
  });

  it('disallows the API mount', async () => {
    expect(await render()).toContain('Disallow: /api/');
  });

  it('does not disallow the whole site', async () => {
    expect(await render()).not.toMatch(/^Disallow: \/$/m);
  });

  // The failure this file is most likely to produce, and the hardest to notice.
  it('leaves every public content path crawlable', async () => {
    const txt = await render();
    const disallowed = [...txt.matchAll(/^Disallow: (.+)$/gm)].map((m) => m[1] as string);

    for (const publicPath of PUBLIC_CRAWLABLE_PATHS) {
      for (const rule of disallowed) {
        expect(publicPath.startsWith(rule)).toBe(false);
      }
    }
  });

  it('states explicitly that everything else is allowed', async () => {
    expect(await render()).toContain('Allow: /');
  });
});

describe('when indexing is disabled', () => {
  const render = () => withIndexing(false, () => renderRobotsTxt());

  it('disallows the entire site', async () => {
    const txt = await render();
    expect(txt).toContain('User-agent: *');
    expect(txt).toMatch(/^Disallow: \/$/m);
  });

  it('does NOT advertise the sitemap — that would contradict the disallow', async () => {
    expect(await render()).not.toContain('Sitemap:');
  });

  it('carries no per-path rules that could be read as permission', async () => {
    expect(await render()).not.toContain('Allow:');
  });
});

describe('the document itself', () => {
  it('is deterministic', async () => {
    await withIndexing(true, () => {
      expect(renderRobotsTxt()).toBe(renderRobotsTxt());
    });
  });

  it('ends with a newline, as a line-oriented format should', async () => {
    expect((await withIndexing(true, () => renderRobotsTxt())).endsWith('\n')).toBe(true);
  });

  it('names the site without disclosing anything about the deployment', async () => {
    const txt = await withIndexing(true, () => renderRobotsTxt());
    expect(txt).toContain('# Narrative');
    expect(txt).not.toMatch(/localhost:\d{4}\b(?!\/)/);
    expect(txt.toLowerCase()).not.toContain('postgres');
    expect(txt.toLowerCase()).not.toContain('redis');
  });
});
