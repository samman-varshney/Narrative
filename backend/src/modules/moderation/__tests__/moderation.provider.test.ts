import { AUTOMATED_REPORT_THRESHOLD } from '../moderation.config';
import { RuleBasedModerationProvider } from '../providers/RuleBasedModerationProvider';
import { activeContentModerationProvider } from '../providers';

/**
 * The local content evaluator.
 *
 * Two classes of assertion, and the second matters more than the first:
 *
 *   it FLAGS the shapes it claims to     — cheap to verify, easy to get right
 *   it LEAVES ORDINARY WRITING ALONE     — the property that decides whether
 *                                          the queue is usable at all
 *
 * A spam heuristic that flags normal posts produces a queue nobody works, which
 * is worse than no heuristic: it buries the human reports underneath.
 */

const provider = new RuleBasedModerationProvider();

const evaluate = (text: string, title?: string) =>
  provider.evaluate({
    targetType: 'COMMENT',
    targetId: 'c1',
    authorId: 'u1',
    text,
    title,
  });

describe('ordinary writing is left alone', () => {
  const legitimate = [
    'Great post — the part about connection pooling matched what we saw in production.',
    'I disagree with the conclusion, but the benchmark methodology is solid. Here is the paper: https://example.com/paper',
    'TIL that Postgres can use a partial index when the query predicate implies the index predicate. Neat.',
    'THIS IS FINE',
    'Thanks!!!',
  ];

  it.each(legitimate)('does not reach the reporting threshold for: %s', async (text) => {
    const result = await evaluate(text);
    expect(result.score).toBeLessThan(AUTOMATED_REPORT_THRESHOLD);
  });

  it('treats empty content as unremarkable rather than suspicious', async () => {
    const result = await evaluate('');
    expect(result.score).toBe(0);
    expect(result.flagged).toBe(false);
  });
});

describe('the shapes it is meant to catch', () => {
  it('flags a link farm', async () => {
    const result = await evaluate(
      'buy https://a.example buy https://b.example buy https://c.example buy https://d.example buy https://e.example'
    );

    expect(result.score).toBeGreaterThanOrEqual(AUTOMATED_REPORT_THRESHOLD);
    expect(result.signals).toEqual(expect.arrayContaining(['many-links', 'link-density']));
  });

  it('flags scam vocabulary paired with links', async () => {
    const result = await evaluate(
      'MAKE MONEY FAST — verify your wallet at https://scam.example and https://scam2.example, limited time offer act now, free gift card, click here to claim'
    );

    expect(result.score).toBeGreaterThanOrEqual(AUTOMATED_REPORT_THRESHOLD);
    expect(result.signals).toContain('scam-vocabulary');
  });

  it('notices shouting only in text long enough to mean it', async () => {
    const short = await evaluate('WOW');
    const long = await evaluate('BUY MY COURSE RIGHT NOW IT IS THE BEST COURSE EVER MADE');

    expect(short.signals).not.toContain('shouting');
    expect(long.signals).toContain('shouting');
  });

  it('notices a copy-pasted phrase repeated through padding', async () => {
    const result = await evaluate(
      'visit my crypto site now ok visit my crypto site now sure visit my crypto site now yes'
    );
    expect(result.signals).toContain('repeated-phrase');
  });

  it('reads the title as well as the body', async () => {
    const bodyOnly = await evaluate('nothing to see');
    const withTitle = await evaluate('nothing to see', 'MAKE MONEY FAST CLICK HERE TO CLAIM');

    expect(withTitle.score).toBeGreaterThan(bodyOnly.score);
  });
});

describe('contract', () => {
  it('is deterministic — the same text always scores the same', async () => {
    const text = 'buy https://a.example https://b.example https://c.example https://d.example';
    const [first, second] = await Promise.all([evaluate(text), evaluate(text)]);
    expect(first).toEqual(second);
  });

  it('keeps the score inside [0, 1] even when every rule fires', async () => {
    const everything = await evaluate(
      'MAKE MONEY FAST!!!!!!!!!! verify your seed phrase https://a.example https://b.example https://c.example https://d.example https://e.example MAKE MONEY FAST MAKE MONEY FAST MAKE MONEY FAST'
    );
    expect(everything.score).toBeLessThanOrEqual(1);
    expect(everything.score).toBeGreaterThan(0);
  });

  it('never throws on hostile input', async () => {
    const hostile = [' '.repeat(100), 'unicode: \u{1D518}\u{1D52B}', '\\'.repeat(500), '   '];
    for (const text of hostile) {
      await expect(evaluate(text)).resolves.toBeDefined();
    }
  });

  it('speaks the report vocabulary, so findings land in the same queue', async () => {
    const result = await evaluate('anything');
    expect(result.reason).toBe('SPAM');
    expect(result.provider).toBe('rule-based');
  });

  it('is the provider the module actually uses', () => {
    expect(activeContentModerationProvider.name).toBe('rule-based');
  });
});
