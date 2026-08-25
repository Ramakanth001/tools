const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ResearchEngine, fallbackObjective, normalizeObjective, validateDraft, unsupportedClaims, pruneUnsupportedDraft,
  acceptedEvidence, shortlistedEvidence, shortlistHasCoreSupport, shortlistCoreSourceCount, mergeSemanticAnchors, adviceEvidence, expansionIds, renderAnswer, simpleDraftSchema, verificationSchemaFor,
  draftSamplingOptions, responseStyleInstruction, evidenceBudgetForContext, answerStartIndex,
  compactAnswerBearingExcerpt, validateExtractiveSelections, validateParagraphSelections, paragraphEvidenceFromBatch, filterVerifiedExtractiveSelections, renderExtractiveAnswer,
  mergeExactEvidence, sourceQuestionEmbeddingText, rerankBySourceQuestion, questionRequestsExamples,
  packCompleteAnswerEvidence, packCompleteAnswerEvidenceBatches, completeAnswerPrompt, completeAnswerParagraphPrompt, chunkItems, mergeSemanticReviewResults,
} = require('../src/research');
const ollama = require('../src/ollama');

test('fallback planning recognizes comparisons and preserves the complete question', () => {
  const objective = fallbackObjective('Compare teaching A versus teaching B');
  assert.equal(objective.intent, 'comparison');
  assert.equal(objective.probes[0].text, 'Compare teaching A versus teaching B');
});

test('temperature presets change drafting style without permitting unbounded sampling', () => {
  assert.deepEqual(draftSamplingOptions(0.1), { temperature: 0.1, top_p: 0.65, top_k: 20 });
  assert.deepEqual(draftSamplingOptions(0.7), { temperature: 0.7, top_p: 0.95, top_k: 20 });
  assert.equal(draftSamplingOptions(9).temperature, 0.3);
  assert.match(responseStyleInstruction(0.1), /verbatim, word-for-word/u);
  assert.match(responseStyleInstruction(0.7), /interpretive paraphrasing/u);
});

test('12K and 16K context admit progressively more evidence and verbatim answers', () => {
  assert.equal(evidenceBudgetForContext(8192).reviewed, 48);
  assert.equal(evidenceBudgetForContext(8192).completeAnswerBatches, 2);
  assert.equal(evidenceBudgetForContext(12288).candidates, 180);
  assert.equal(evidenceBudgetForContext(12288).reviewed, 96);
  assert.equal(evidenceBudgetForContext(12288).selections, 10);
  assert.equal(evidenceBudgetForContext(16384).selections, 12);
  assert.equal(evidenceBudgetForContext(16384).completeAnswerBatches, 4);
});

test('verbatim mode removes a matched source question and preserves the exact indexed answer span', () => {
  const excerpt = '[A devotee asked: May I pray for success?]\nSwami Replied:- Love to God without aspiration for any fruit in return can come only through strong effort or Saadhanaa. Once aspiration for fruit exists, such love is not real and pure.';
  const evidence = [{ evidenceId: 'E1', sourceId: 'discourse:2296', sourceGroup: 'g1', passageIndex: 1,
    start: 200, end: 200 + excerpt.length, excerpt, title: 'How to love God without aspiring for fruit?', metadata: {} }];
  assert.ok(answerStartIndex(excerpt) > 0);
  const selected = validateExtractiveSelections({ answerable: true, selections: [{ evidence_id: 'E1', exact_quote: excerpt }] }, evidence, 8);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].excerpt, 'Love to God without aspiration for any fruit in return can come only through strong effort or Saadhanaa. Once aspiration for fruit exists, such love is not real and pure.');
  assert.equal(selected[0].start, 200 + excerpt.indexOf('Love to God'));
  assert.equal(excerpt.slice(selected[0].start - 200, selected[0].end - 200), selected[0].excerpt);
  const rendered = renderExtractiveAnswer(selected);
  assert.match(rendered.answer, /^Love to God/u);
  assert.match(rendered.answer, /pure\. \[1\]$/u);
  assert.doesNotMatch(rendered.answer, /^###/u);
  assert.doesNotMatch(rendered.answer, /A devotee asked/u);
  assert.equal(rendered.sources[0].adjudication.verbatim, true);
});

test('compact semantic previews start at the recorded answer instead of truncating it behind a long question', () => {
  const excerpt = `${'A long recorded question? '.repeat(30)}\nSwami Replied:- The answer-bearing doctrine begins here and remains visible.`;
  assert.match(compactAnswerBearingExcerpt(excerpt, 90), /^Swami Replied:- The answer-bearing doctrine/u);
});

test('verbatim mode rejects model paraphrases that are not exact corpus substrings', () => {
  const evidence = [{ evidenceId: 'E1', sourceId: 's1', passageIndex: 0, start: 0, end: 90,
    excerpt: 'Love to God without aspiration for any fruit in return is real and pure spiritual love.', title: 'Source', metadata: {} }];
  const selected = validateExtractiveSelections({ answerable: true, selections: [{
    evidence_id: 'E1', exact_quote: 'True devotion means asking God for nothing in return.',
  }] }, evidence, 8);
  assert.deepEqual(selected, []);
});

test('verbatim mode rejects a retrieved question when it contains no answer', () => {
  const excerpt = 'Ambition for a higher position is useful in worldly life. Does it apply in spiritual life also?';
  const evidence = [{ evidenceId: 'E1', sourceId: 's1', passageIndex: 0, start: 0, end: excerpt.length, excerpt, title: 'Question', metadata: {} }];
  assert.deepEqual(validateExtractiveSelections({ answerable: true, selections: [{ evidence_id: 'E1', exact_quote: excerpt }] }, evidence, 4), []);
});

test('verbatim mode rejects a bracketed source question even when it ends with a closing bracket', () => {
  const excerpt = '[A devotee asked: Is it necessary to ask God separately for this benefit?]';
  const evidence = [{ evidenceId: 'E1', sourceId: 's1', passageIndex: 0, start: 0, end: excerpt.length, excerpt, title: 'Question', metadata: {} }];
  assert.deepEqual(validateExtractiveSelections({ answerable: true, selections: [{ evidence_id: 'E1', exact_quote: excerpt }] }, evidence, 4), []);
});

test('verbatim mode rejects incomplete sentence fragments', () => {
  const excerpt = 'If the request is beneficial, the result may be granted,';
  const evidence = [{ evidenceId: 'E1', sourceId: 's1', passageIndex: 0, start: 0, end: excerpt.length, excerpt, title: 'Source', metadata: {} }];
  assert.deepEqual(validateExtractiveSelections({ answerable: true, selections: [{ evidence_id: 'E1', exact_quote: excerpt }] }, evidence, 4), []);
});

test('verbatim citations deduplicate adjacent chunks from the same source group', () => {
  const quote = 'One should follow this complete and directly relevant corpus sentence.';
  const evidence = [
    { evidenceId: 'E1', sourceId: 's:001', sourceGroup: 's', passageIndex: 0, start: 0, end: quote.length, excerpt: quote, title: 'Source', metadata: {} },
    { evidenceId: 'E2', sourceId: 's:002', sourceGroup: 's', passageIndex: 0, start: 0, end: quote.length, excerpt: quote, title: 'Source', metadata: {} },
  ];
  const selected = validateExtractiveSelections({ answerable: true, selections: evidence.map((item) => ({ evidence_id: item.evidenceId, exact_quote: quote })) }, evidence, 4);
  assert.equal(selected.length, 1);
});

test('exact evidence merging keeps distinct relevant paragraphs from one answer and removes only exact duplicates', () => {
  const base = { sourceId: 's1', sourceGroup: 'g1', evidenceId: 'E1' };
  const merged = mergeExactEvidence(
    [{ ...base, excerpt: 'The example began and the result was requested.' }],
    [{ ...base, excerpt: 'A separate relevant paragraph from the same complete answer.' },
      { ...base, excerpt: 'The example began and the result was requested.' },
      { sourceId: 's2', sourceGroup: 'g2', evidenceId: 'E2', excerpt: 'A separate governing principle.' }],
    4,
  );
  assert.deepEqual(merged.map((item) => item.sourceId), ['s1', 's1', 's2']);
  assert.equal(merged[1].excerpt, 'A separate relevant paragraph from the same complete answer.');
});

test('a selected sentence expands to its complete original answer paragraph', () => {
  const paragraph = 'Love to God without aspiration for any fruit in return can come only through strong effort. Once aspiration for fruit exists, such love is not real and pure. If such pure love exists, God Himself will help you with utmost sincerity.';
  const evidence = [{ evidenceId: 'A1', sourceId: 's1', sourceGroup: 'g1', start: 40, end: 40 + paragraph.length,
    excerpt: paragraph, answerBoundary: 'explicit_reply', title: 'Question', metadata: {} }];
  const selected = validateExtractiveSelections({ answerable: true, selections: [{ evidence_id: 'A1', exact_quote: 'God Himself will help you with utmost sincerity.' }] }, evidence, 4);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].excerpt, paragraph);
  assert.equal(selected[0].start, 40);
});

test('multiple non-contiguous paragraphs from one complete answer remain independently citable', () => {
  const excerpt = 'First complete governing paragraph directly answers the user question.\n\nSecond complete and independently relevant paragraph explains another necessary condition.';
  const evidence = [{ evidenceId: 'A1', sourceId: 's1', sourceGroup: 'g1', start: 0, end: excerpt.length,
    excerpt, answerBoundary: 'explicit_reply', title: 'Question', metadata: {} }];
  const selected = validateExtractiveSelections({ answerable: true, selections: [
    { evidence_id: 'A1', exact_quote: 'First complete governing paragraph directly answers the user question.' },
    { evidence_id: 'A1', exact_quote: 'Second complete and independently relevant paragraph explains another necessary condition.' },
  ] }, evidence, 4);
  assert.deepEqual(selected.map((item) => item.excerpt), [
    'First complete governing paragraph directly answers the user question.',
    'Second complete and independently relevant paragraph explains another necessary condition.',
  ]);
  assert.notEqual(selected[0].evidenceId, selected[1].evidenceId);
});

test('server paragraph IDs preserve exact complete-answer text and offsets without model quotation JSON', () => {
  const excerpt = 'First full answer paragraph gives the governing rule with necessary detail.\n\nSecond full answer paragraph adds a distinct and useful qualification.';
  const segment = { evidenceId: 'A1_1', sourceId: 's1', sourceGroup: 'g1', passageIndex: 0, start: 50, end: 50 + excerpt.length,
    excerpt, answerBoundary: 'explicit_reply', title: 'Recorded question?', metadata: {} };
  const paragraphs = paragraphEvidenceFromBatch([segment]);
  assert.deepEqual(paragraphs.map((item) => item.excerpt), [
    'First full answer paragraph gives the governing rule with necessary detail.',
    'Second full answer paragraph adds a distinct and useful qualification.',
  ]);
  assert.equal(paragraphs[1].start, 50 + excerpt.indexOf('Second'));
  const selected = validateParagraphSelections({ answerable: true, selections: [{ evidence_id: 'P2' }, { evidence_id: 'P1' }] }, paragraphs, 4);
  assert.deepEqual(selected.map((item) => item.excerpt), [paragraphs[1].excerpt, paragraphs[0].excerpt]);
  assert.match(completeAnswerParagraphPrompt(paragraphs), /exact_paragraph P1/u);
  assert.doesNotMatch(JSON.stringify({ selections: [{ evidence_id: 'P1' }] }), /governing rule/u);
});

test('complete-answer packing excludes unsolicited experience narratives but allows them when requested', () => {
  const doctrine = { sourceGroup: 'doctrine', answerBoundary: 'explicit_reply', segments: [{ sourceId: 'd1', sourceGroup: 'doctrine', excerpt: 'A complete doctrinal answer.', adjudication: { support_type: 'governing_principle' } }] };
  const secondDoctrine = { sourceGroup: 'doctrine-two', answerBoundary: 'explicit_reply', segments: [{ sourceId: 'd2', sourceGroup: 'doctrine-two', excerpt: 'A second complete doctrinal answer.', adjudication: { support_type: 'direct_answer' } }] };
  const experience = { sourceGroup: 'experience', answerBoundary: 'document', segments: [{ sourceId: 'x1', sourceGroup: 'experience', excerpt: 'A personal promotion experience.', adjudication: { support_type: 'relevant_example' } }] };
  const misclassifiedNarrative = { ...experience, sourceGroup: 'misclassified', segments: [{ ...experience.segments[0], sourceGroup: 'misclassified', adjudication: { support_type: 'direct_answer' } }] };
  const direct = packCompleteAnswerEvidence([experience, misclassifiedNarrative, doctrine, secondDoctrine], { standalone_question: 'May I ask for this benefit?' }, 12288);
  assert.deepEqual(new Set(direct.map((item) => item.sourceGroup)), new Set(['doctrine', 'doctrine-two']));
  const requested = packCompleteAnswerEvidence([experience, doctrine], { standalone_question: 'Give me an example or experience.' }, 12288);
  assert.deepEqual(new Set(requested.map((item) => item.sourceGroup)), new Set(['doctrine', 'experience']));
  assert.equal(questionRequestsExamples('Can you explain the principle?'), false);
  assert.equal(questionRequestsExamples('Give me an example'), true);
  assert.match(completeAnswerPrompt(direct), /COMPLETE ANSWER/u);
});

test('complete-answer packing reads several bounded batches without splitting a source answer', () => {
  const largeText = (label) => `${label} ${'complete doctrinal answer sentence. '.repeat(500)}`;
  const units = Array.from({ length: 4 }, (_, index) => ({
    sourceGroup: `group-${index + 1}`, answerBoundary: 'explicit_reply',
    segments: [{ sourceId: `s${index + 1}`, sourceGroup: `group-${index + 1}`, excerpt: largeText(`Doctrine ${index + 1}.`),
      adjudication: { support_type: 'governing_principle' }, retrievalRank: index + 1 }],
  }));
  const batches = packCompleteAnswerEvidenceBatches(units, { standalone_question: 'What is the principle?' }, 8192, 3);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => new Set(batch.map((item) => item.sourceGroup)).size), [1, 1, 1]);
  assert.deepEqual(batches.map((batch) => batch[0].evidenceId), ['A1_1', 'A2_1', 'A3_1']);
});

test('protected top semantic anchors are read before lower-confidence shortlist roles', () => {
  const units = [
    { sourceGroup: 'shortlisted', answerBoundary: 'explicit_reply', segments: [{ sourceId: 's1', sourceGroup: 'shortlisted', excerpt: 'A sufficiently long shortlisted answer paragraph.', retrievalRank: 20, adjudication: { support_type: 'direct_answer' } }] },
    { sourceGroup: 'anchor', answerBoundary: 'explicit_reply', segments: [{ sourceId: 's2', sourceGroup: 'anchor', excerpt: 'A sufficiently long protected semantic answer paragraph.', retrievalRank: 4, protectedSemanticAnchor: true, adjudication: { support_type: 'semantic_question_anchor' } }] },
  ];
  const packed = packCompleteAnswerEvidence(units, { standalone_question: 'May I ask for this?' }, 8192);
  assert.equal(packed[0].sourceGroup, 'anchor');
});

test('exact answer relevance is decided by a semantic verification contract, not keyword rules', () => {
  const spiritual = 'If you want to rise to higher spiritual levels, you need not pray to God for that.';
  const career = '[A devotee asked about an interview and success.]\nSwami Replied:- Love to God without aspiration for any fruit in return is real and pure. God Himself will help you with utmost sincerity.';
  const evidence = [
    { evidenceId: 'E1', sourceId: 's1', passageIndex: 0, start: 0, end: spiritual.length, excerpt: spiritual, title: 'Efforts to reach higher spiritual levels', metadata: {}, retrievalRank: 1 },
    { evidenceId: 'E2', sourceId: 's2', passageIndex: 1, start: 100, end: 100 + career.length, excerpt: career, title: 'How to let go of success after a job interview and love God without aspiring for fruit?', metadata: {}, retrievalRank: 15 },
  ];
  const extracted = validateExtractiveSelections({ answerable: true, selections: [
    { evidence_id: 'E1', exact_quote: spiritual }, { evidence_id: 'E2', exact_quote: career },
  ] }, evidence, 6, 'I want a promotion in my job. Can I ask God for a boon?');
  const selected = filterVerifiedExtractiveSelections({ judgments: [
    { evidence_id: extracted[0].evidenceId, support_type: 'irrelevant', reason: 'Different kind of advancement.' },
    { evidence_id: extracted[1].evidenceId, support_type: 'direct_answer', reason: 'Answers the requested relationship.' },
  ] }, extracted, 6);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sourceId, 's2');
  assert.match(selected[0].excerpt, /^Love to God without aspiration/u);
  assert.equal(selected[0].answerVerification.support_type, 'direct_answer');
});

test('semantic exact-answer verification rejects merely topical citations', () => {
  const question = 'I want promotion in my job can I ask God for boon?';
  const rows = [
    ['E1', 'How to let go of success and love God without aspiring for practical fruit?', 'Swami Replied:- Love to God without aspiration for any fruit in return can come only through strong effort. Once the aspiration for fruit exists, such love is not real and pure.'],
    ['E2', 'DATTA JAYANTI MESSAGE - II', 'God will certainly do miracles if He has a hope about you that the miracles will help you in the spiritual path.'],
    ['E3', 'Divine Experiences', 'I gave up all aspiration for my promotion and dedicated myself to my worldly duty and divine service. Quite surprisingly, I got the promotion, without any complication.'],
    ['E4', 'Satsanga in Mumbai-1', 'When you develop talent in your profession due to long experience, you can enter Yoga while simultaneously doing your professional work.'],
    ['E5', 'Human being and God', 'The right and complete divine spiritual knowledge given by God alone can bring you the success.'],
    ['E6', 'Divine service', 'Some devotees develop skills and arrange their work so that it proceeds automatically with minimal intervention.'],
  ];
  const evidence = rows.map(([evidenceId, title, excerpt], index) => ({
    evidenceId, sourceId: `s${index + 1}`, passageIndex: 0, start: 0, end: excerpt.length,
    excerpt, title, metadata: {}, retrievalRank: index + 1,
  }));
  const extracted = validateExtractiveSelections({ answerable: true, selections: evidence.map((item) => ({
    evidence_id: item.evidenceId, exact_quote: item.excerpt,
  })) }, evidence, 6, question);
  const selected = filterVerifiedExtractiveSelections({ judgments: extracted.map((item) => ({
    evidence_id: item.evidenceId,
    support_type: ['E1', 'E3'].includes(item.originEvidenceId) ? (item.originEvidenceId === 'E1' ? 'governing_principle' : 'relevant_example') : 'irrelevant',
    reason: 'Independent semantic verdict.',
  })) }, extracted, 6);
  assert.deepEqual(selected.map((item) => item.originEvidenceId), ['E1']);
  assert.doesNotMatch(renderExtractiveAnswer(selected).answer, /talent|spiritual knowledge|automatically/iu);
});

test('verified distinct answer types remain available for a developed corpus answer', () => {
  const evidence = [
    { evidenceId: 'Q1', sourceGroup: 'g1', retrievalRank: 1 }, { evidenceId: 'Q2', sourceGroup: 'g2', retrievalRank: 2 }, { evidenceId: 'Q3', sourceGroup: 'g3', retrievalRank: 3 },
  ];
  const selected = filterVerifiedExtractiveSelections({ judgments: [
    { evidence_id: 'Q1', support_type: 'governing_principle', reason: 'Explains the general doctrine.' },
    { evidence_id: 'Q2', support_type: 'qualification', reason: 'Preserves the necessary condition.' },
    { evidence_id: 'Q3', support_type: 'direct_answer', reason: 'Repeats the conclusion through an analogy.' },
  ] }, evidence, 6);
  assert.deepEqual(selected.map((item) => item.evidenceId), ['Q3', 'Q1', 'Q2']);
});

test('final exact answers keep at most two paragraphs from one source group', () => {
  const evidence = [
    { evidenceId: 'Q1', sourceGroup: 'same', retrievalRank: 1 }, { evidenceId: 'Q2', sourceGroup: 'same', retrievalRank: 2 },
    { evidenceId: 'Q3', sourceGroup: 'same', retrievalRank: 3 }, { evidenceId: 'Q4', sourceGroup: 'different', retrievalRank: 4 },
  ];
  const judgments = evidence.map((item) => ({ evidence_id: item.evidenceId, support_type: 'governing_principle', reason: 'Useful doctrine.' }));
  assert.deepEqual(filterVerifiedExtractiveSelections({ judgments }, evidence, 8).map((item) => item.evidenceId), ['Q1', 'Q2', 'Q4']);
});

test('objective normalization limits probes and falls back when the model returns none', () => {
  const fallback = normalizeObjective({ probes: [] }, 'What is truth?', {});
  assert.equal(fallback.probes.length, 1);
  const normalized = normalizeObjective({ probes: Array.from({ length: 8 }, (_, index) => ({ text: `q${index}`, purpose: 'primary' })) }, 'q', {});
  assert.equal(normalized.probes.length, 2);
  assert.equal(normalized.probes[0].text, 'q');
  const advice = normalizeObjective({ intent: 'advice', probes: Array.from({ length: 8 }, (_, index) => ({ text: `a${index}`, purpose: 'relationship' })) }, 'May I ask for this?', {});
  assert.equal(advice.probes.length, 4);
});

test('direct advice planning always searches the actual user question first', () => {
  const fallback = fallbackObjective('What is the best way to reach God?');
  assert.equal(fallback.intent, 'advice');
  const objective = normalizeObjective({
    intent: 'direct', standalone_question: 'What is the best way to reach God?',
    probes: [{ text: 'How do major world religions describe God?', purpose: 'comparison_side' }],
  }, 'What is the best way to reach God?', {});
  assert.equal(objective.intent, 'advice');
  assert.deepEqual(objective.probes.map((probe) => probe.text), [
    'What is the best way to reach God?', 'How do major world religions describe God?',
  ]);
});

test('permission-seeking practical questions use the broader advice flow', () => {
  const objective = fallbackObjective('I want promotion in my job can I ask God for boon?');
  assert.equal(objective.intent, 'advice');
  assert.equal(objective.probes.length, 4);
  assert.equal(objective.probes[0].text, 'I want promotion in my job can I ask God for boon?');
});

test('expanded retrieval forwards the larger per-channel corpus budget', async () => {
  const originalEmbed = ollama.embed;
  const seen = [];
  ollama.embed = async () => ({ embeddings: [[0.5]], metrics: {} });
  try {
    const engine = new ResearchEngine({ corpus: {
      searchProbe: async (_vector, _query, options) => { seen.push(options); return []; },
      fuseProbeResults: () => [],
    } });
    await engine.retrieve([{ text: 'path to God', purpose: 'primary' }], {
      embeddingDimension: 1, embeddingFormatVersion: 'embeddinggemma-asymmetric-v3',
    }, { ollamaBaseUrl: 'http://127.0.0.1:11434', embeddingModel: 'embeddinggemma' }, undefined,
    { channelLimit: 60, resultLimit: 80 });
    assert.equal(seen[0].channelLimit, 60);
    assert.equal(seen[0].resultLimit, 80);
  } finally { ollama.embed = originalEmbed; }
});

test('a timed-out broad probe retries read-only retrieval at a smaller proven budget', async () => {
  const originalEmbed = ollama.embed;
  const seen = [];
  ollama.embed = async () => ({ embeddings: [[0.5]], metrics: {} });
  try {
    const engine = new ResearchEngine({ corpus: {
      searchProbe: async (_vector, _query, options) => {
        seen.push(options);
        if (seen.length === 1) throw new Error('canceling statement due to statement timeout');
        return [];
      },
      fuseProbeResults: () => [],
    } });
    const result = await engine.retrieve([{ text: 'question', purpose: 'primary' }], {
      embeddingDimension: 1, embeddingFormatVersion: 'embeddinggemma-asymmetric-v3',
    }, { ollamaBaseUrl: 'http://127.0.0.1:11434', embeddingModel: 'embeddinggemma' }, undefined,
    { channelLimit: 100, resultLimit: 200, fuseLimit: 260 });
    assert.equal(result.degradedProbes, 1);
    assert.equal(seen[1].channelLimit, 60);
    assert.equal(seen[1].resultLimit, 90);
  } finally { ollama.embed = originalEmbed; }
});

test('source-question reranking uses EmbeddingGemma document format and semantic similarity', () => {
  assert.equal(sourceQuestionEmbeddingText('How should I pray?', 'embeddinggemma-asymmetric-v3'),
    'title: How should I pray? | text: How should I pray?');
  const reranked = rerankBySourceQuestion(
    [{ sourceId: 'passage-first' }, { sourceId: 'question-match' }],
    [1, 0],
    [[0, 1], [1, 0]],
  );
  assert.equal(reranked[0].sourceId, 'question-match');
  assert.equal(reranked[0].scores.questionSimilarity, 1);
});

test('semantic adjudication requires the requested relationship even for broad advice', () => {
  const candidates = [{ evidenceId: 'E1', retrievalRank: 1 }, { evidenceId: 'E2', retrievalRank: 2 }];
  const adjudication = { judgments: [
    { evidence_id: 'E1', directly_answers: true, relationship_matches: false, relevance: 3, stance: 'supports', ambiguous: false },
    { evidence_id: 'E2', directly_answers: false, relationship_matches: false, relevance: 2, stance: 'qualifies', ambiguous: false },
  ] };
  assert.deepEqual(acceptedEvidence(candidates, adjudication, { intent: 'advice' }).map((item) => item.evidenceId), []);
  assert.deepEqual(acceptedEvidence(candidates, adjudication, { intent: 'comparison' }), []);
});

test('semantic shortlisting keeps only model-selected answer-bearing evidence and preserves its support role', () => {
  const candidates = [
    { evidenceId: 'E1', sourceId: 'answer', retrievalRank: 4 },
    { evidenceId: 'E2', sourceId: 'keyword-match', retrievalRank: 1 },
    { evidenceId: 'E3', sourceId: 'example', retrievalRank: 5 },
  ];
  const selected = shortlistedEvidence(candidates, { selections: [
    { evidence_id: 'E3', support_type: 'relevant_example', relevance: 3, reason: 'Directly applicable example.' },
    { evidence_id: 'E1', support_type: 'direct_answer', relevance: 3, reason: 'Answers the requested proposition.' },
  ] }, 12);
  assert.deepEqual(selected.map((item) => item.sourceId), ['answer', 'example']);
  assert.equal(selected[0].adjudication.support_type, 'direct_answer');
});

test('strong direct or governing evidence suppresses unnecessary semantic follow-up searches', () => {
  assert.equal(shortlistHasCoreSupport({ selections: [{ support_type: 'governing_principle', relevance: 3 }] }), true);
  assert.equal(shortlistHasCoreSupport({ selections: [{ support_type: 'relevant_example', relevance: 3 }] }), false);
  assert.equal(shortlistHasCoreSupport({ selections: [{ support_type: 'direct_answer', relevance: 2 }] }), false);
});

test('follow-up suppression requires broad support from four distinct source groups', () => {
  const candidates = Array.from({ length: 4 }, (_, index) => ({ evidenceId: `E${index + 1}`, sourceGroup: `g${index + 1}` }));
  const selections = candidates.map((item) => ({ evidence_id: item.evidenceId, support_type: 'governing_principle', relevance: 3 }));
  assert.equal(shortlistCoreSourceCount({ selections: selections.slice(0, 3) }, candidates), 3);
  assert.equal(shortlistCoreSourceCount({ selections }, candidates), 4);
});

test('candidate review batching preserves every candidate exactly once', () => {
  const values = Array.from({ length: 70 }, (_, index) => `E${index + 1}`);
  const batches = chunkItems(values, 32);
  assert.deepEqual(batches.map((batch) => batch.length), [32, 32, 6]);
  assert.deepEqual(batches.flat(), values);
});

test('targeted follow-up review is merged without repeating initial semantic judgments', () => {
  const initial = { value: { selections: [{ evidence_id: 'E1' }], expand_ids: ['E1'] }, metrics: { batchCount: 3, batches: [{}, {}, {}] } };
  const followup = { value: { selections: [{ evidence_id: 'F1' }], expand_ids: ['F1'] }, metrics: { batchCount: 1, batches: [{}] } };
  const merged = mergeSemanticReviewResults(initial, followup, true);
  assert.deepEqual(merged.value.selections.map((item) => item.evidence_id), ['E1', 'F1']);
  assert.deepEqual(merged.value.expand_ids, ['E1', 'F1']);
  assert.equal(merged.metrics.batchCount, 4);
});

test('top semantic question anchors remain available for exact-answer verification despite shortlist variance', () => {
  const selected = [{ sourceId: 'selected', sourceGroup: 'selected', adjudication: { support_type: 'direct_answer' } }];
  const anchors = [{ sourceId: 'anchor', sourceGroup: 'anchor' }, { sourceId: 'selected:chunk', sourceGroup: 'selected' }];
  const merged = mergeSemanticAnchors(selected, anchors, 4);
  assert.deepEqual(merged.map((item) => item.sourceGroup), ['selected', 'anchor']);
  assert.equal(merged[0].adjudication.support_type, 'direct_answer');
  assert.equal(merged[1].adjudication.support_type, 'semantic_question_anchor');
  assert.equal(merged[1].protectedSemanticAnchor, true);
});

test('standalone practical questions use four deterministic semantic probes without a Qwen planning call', async () => {
  const originalChatJson = ollama.chatJson;
  let calls = 0;
  ollama.chatJson = async () => { calls += 1; return { value: {
    standalone_question: 'broader model rewrite', intent: 'advice', language: 'English', entities: ['promotion'], facets: ['underlying spiritual principle'],
    probes: [{ text: 'devotion and desired outcomes', purpose: 'relationship' }], memory: { topic: 'promotion', entities: [], unresolved: [], preferences: [] },
  }, metrics: {} }; };
  try {
    const engine = new ResearchEngine({ corpus: {} });
    const question = 'I want promotion in my job can I ask God for boon?';
    const planned = await engine.plan(question, { messages: [], memory: {} }, { contextTokens: 12288 }, undefined);
    assert.equal(calls, 0);
    assert.equal(planned.objective.standalone_question, question);
    assert.equal(planned.objective.probes[0].text, question);
    assert.equal(planned.objective.probes.length, 4);
    assert.match(planned.objective.probes[1].text, /Governing spiritual principle/u);
  } finally { ollama.chatJson = originalChatJson; }
});

test('broad advice fast path excludes question-only fragments', () => {
  const evidence = adviceEvidence([
    { evidenceId: 'E1', excerpt: 'Is spiritual knowledge the only way?' },
    { evidenceId: 'E2', excerpt: 'The path begins with true spiritual knowledge, develops devotion, and becomes practical through selfless service and sacrifice to God.' },
  ]);
  assert.deepEqual(evidence.map((item) => item.evidenceId), ['E2']);
});

test('broad advice considers a larger source-diverse evidence set', () => {
  const candidates = Array.from({ length: 14 }, (_, index) => ({
    evidenceId: `E${index + 1}`,
    sourceId: `source-${index + 1}`,
    sourceGroup: index < 4 ? 'same-book' : `book-${index}`,
    excerpt: `This passage ${index + 1} gives a complete supported spiritual teaching with enough detail to contribute to a careful synthesis.`,
  }));
  const evidence = adviceEvidence(candidates);
  assert.equal(evidence.length, 12);
  assert.equal(evidence.filter((item) => item.sourceGroup === 'same-book').length, 2);
  assert.ok(new Set(evidence.map((item) => item.sourceGroup)).size >= 11);
});

test('context expansion selects distinct sources instead of duplicate passages', () => {
  assert.deepEqual(expansionIds([
    { evidenceId: 'E1', sourceGroup: 'book-a' },
    { evidenceId: 'E2', sourceGroup: 'book-a' },
    { evidenceId: 'E3', sourceGroup: 'book-b' },
    { evidenceId: 'E4', sourceId: 'single-c' },
  ]), ['E1', 'E3', 'E4']);
});

test('question-like discoveries are expanded before semantic judgment so their recorded answers are visible', async () => {
  const calls = [];
  const engine = new ResearchEngine({ corpus: {
    expandEvidence: async (item) => { calls.push(item.evidenceId); return [{ ...item, excerpt: `${item.excerpt}\nSwami Replied:- This complete answer is now visible.` }]; },
  } });
  const items = [
    { evidenceId: 'E1', sourceId: 's1', title: 'How does this work?', excerpt: 'How does this work?' },
    { evidenceId: 'E2', sourceId: 's2', title: 'Statement', excerpt: 'This is already a complete answer.' },
  ];
  const expanded = await engine.expandQuestionAnswerDiscoveries(items);
  assert.deepEqual(calls, ['E1']);
  assert.match(expanded[0].excerpt, /complete answer/u);
  assert.equal(expanded[1].excerpt, items[1].excerpt);
});

test('draft validation rejects invented evidence IDs and model-authored citation markers', () => {
  const draft = validateDraft({
    answerable: true,
    paragraphs: [{ text: 'Supported statement [E1].', evidence_ids: ['E1', 'E99'] }],
    claims: [{ text: 'Supported statement.', evidence_ids: ['E1', 'E99'] }],
  }, ['E1']);
  assert.equal(draft.answerable, true);
  assert.equal(draft.paragraphs[0].text, 'Supported statement.');
  assert.deepEqual(draft.paragraphs[0].evidence_ids, ['E1']);
  const parenthetical = validateDraft({
    answerable: true,
    paragraphs: [{ text: 'Another supported statement (E1).', evidence_ids: ['E1'] }],
    claims: [{ text: 'Another supported statement.', evidence_ids: ['E1'] }],
  }, ['E1']);
  assert.equal(parenthetical.paragraphs[0].text, 'Another supported statement.');
  const attributed = validateDraft({
    answerable: true,
    paragraphs: [{ text: 'For instance, [E1] and [E2] both clarify the path. [E3] outlines the next step.', evidence_ids: ['E1', 'E2', 'E3'] }],
    claims: [],
  }, ['E1', 'E2', 'E3']);
  assert.equal(attributed.paragraphs[0].text, 'For instance, one passage and another passage both clarify the path. One passage outlines the next step.');
});

test('simple draft schema verifies paragraphs directly without duplicating atomic claims', () => {
  assert.equal(simpleDraftSchema.properties.claims.maxItems, 0);
  assert.equal(simpleDraftSchema.properties.paragraphs.maxItems, 4);
  const draft = validateDraft({
    answerable: true,
    paragraphs: [{ text: 'A bounded supported answer.', evidence_ids: ['E1'] }],
    claims: [],
  }, ['E1']);
  assert.equal(draft.answerable, true);
  const verification = verificationSchemaFor(draft, true);
  assert.equal(verification.properties.claims.maxItems, 0);
  assert.equal(verification.properties.paragraphs.minItems, 1);
  assert.equal(verification.properties.paragraphs.maxItems, 1);
  assert.deepEqual(verification.properties.paragraphs.items.required, ['paragraph_index', 'verdict', 'valid_evidence_ids']);
});

test('unsupported claim detection requires an explicit supported verdict', () => {
  const draft = { claims: [{ text: 'one', evidence_ids: ['E1'] }, { text: 'two', evidence_ids: ['E2'] }] };
  const unsupported = unsupportedClaims(draft, { claims: [
    { claim_index: 0, verdict: 'supported', valid_evidence_ids: ['E1'] },
    { claim_index: 1, verdict: 'insufficient', valid_evidence_ids: [] },
  ] });
  assert.deepEqual(unsupported.map((item) => item.index), [1]);
});

test('verification cannot substitute an invented or unreferenced evidence ID', () => {
  const draft = {
    claims: [{ text: 'claim', evidence_ids: ['E1'] }],
    paragraphs: [{ text: 'paragraph', evidence_ids: ['E1'] }],
  };
  const unsupported = unsupportedClaims(draft, {
    claims: [{ claim_index: 0, verdict: 'supported', valid_evidence_ids: ['E99'] }],
    paragraphs: [{ paragraph_index: 0, verdict: 'supported', valid_evidence_ids: ['E99'] }],
  });
  assert.deepEqual(unsupported.map((item) => item.type), ['claim', 'paragraph']);
});

test('verification salvage retains supported paragraphs instead of discarding the whole answer', () => {
  const draft = {
    answerable: true,
    paragraphs: [{ text: 'Supported.', evidence_ids: ['E1'] }, { text: 'Too broad.', evidence_ids: ['E2'] }],
    claims: [{ text: 'Supported.', evidence_ids: ['E1'] }, { text: 'Too broad.', evidence_ids: ['E2'] }],
  };
  const pruned = pruneUnsupportedDraft(draft, {
    paragraphs: [
      { paragraph_index: 0, verdict: 'supported', valid_evidence_ids: ['E1'] },
      { paragraph_index: 1, verdict: 'insufficient', valid_evidence_ids: [] },
    ],
    claims: [
      { claim_index: 0, verdict: 'supported', valid_evidence_ids: ['E1'] },
      { claim_index: 1, verdict: 'insufficient', valid_evidence_ids: [] },
    ],
  });
  assert.equal(pruned.answerable, true);
  assert.deepEqual(pruned.paragraphs.map((item) => item.text), ['Supported.']);
});

test('citation rendering is deterministic and creates future-compatible locators', () => {
  const draft = { paragraphs: [{ text: 'First.', evidence_ids: ['E2'] }, { text: 'Second.', evidence_ids: ['E1', 'E2'] }] };
  const evidence = [
    { evidenceId: 'E1', sourceId: 's1', passageIndex: 0, start: 0, end: 5, excerpt: 'one', metadata: { book: 'Book', page: 7 } },
    { evidenceId: 'E2', sourceId: 's2', passageIndex: 1, start: 6, end: 10, excerpt: 'two', metadata: {} },
  ];
  const rendered = renderAnswer(draft, evidence);
  assert.equal(rendered.answer, 'First. [1]\n\nSecond. [2][1]');
  assert.equal(rendered.sources[0].sourceId, 's2');
  assert.deepEqual(rendered.sources[1].locator, { book: 'Book', page: 7 });
});
