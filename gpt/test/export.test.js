const test = require('node:test');
const assert = require('node:assert/strict');

test('all answer export formats contain clear exact citations but never a full discourse', async () => {
  const { answerExportMarkdown, answerExportText, answerExportHtml, answerExportFilename } = await import('../src/ui/export.mjs');
  const input = {
    title: 'What is the best way to reach God?',
    message: {
      content: 'The corpus describes a path of knowledge and selfless love. [1]',
      sources: [{
        citationNumber: 1,
        title: 'A SPIRITUAL DISCOURSE',
        sourceId: 'source-1',
        passageIndex: 7,
        start: 120,
        end: 184,
        excerpt: 'This is the exact cited passage used to support the answer.',
        sourceAnswer: 'THIS FULL DISCOURSE MUST NEVER BE EXPORTED',
        metadata: { source_type: 'Discourse', record_date: '2024-01-02', book: 'Book One', page: 9, source_context: 'FULL METADATA DISCOURSE MUST NEVER BE EXPORTED' },
        locator: { book: 'Book One', page: 9 },
      }],
    },
  };
  const markdown = answerExportMarkdown(input);
  assert.match(markdown, /## All relevant citations/u);
  assert.match(markdown, /### \[1\] A SPIRITUAL DISCOURSE/u);
  assert.match(markdown, /\*\*Exact cited excerpt\*\*/u);
  assert.match(markdown, /> This is the exact cited passage used to support the answer\./u);
  assert.match(markdown, /Exact span: characters 120–184/u);
  assert.doesNotMatch(markdown, /FULL DISCOURSE/u);
  assert.doesNotMatch(markdown, /FULL METADATA/u);
  assert.equal(answerExportFilename('What is God?'), 'What is God.md');
  assert.equal(answerExportFilename('What is God?', 'pdf'), 'What is God.pdf');

  const text = answerExportText(input);
  assert.match(text, /CITATIONS/u);
  assert.match(text, /Exact cited excerpt:/u);
  assert.match(text, /This is the exact cited passage/u);
  assert.doesNotMatch(text, /FULL DISCOURSE|FULL METADATA/u);

  const html = answerExportHtml(input);
  assert.match(html, /<h2>All relevant citations<\/h2>/u);
  assert.match(html, /Exact cited excerpt/u);
  assert.match(html, /This is the exact cited passage/u);
  assert.doesNotMatch(html, /FULL DISCOURSE|FULL METADATA/u);

  const doc = answerExportHtml({ ...input, wordCompatible: true });
  assert.match(doc, /urn:schemas-microsoft-com:office:word/u);
  assert.match(doc, /ProgId/u);

  const verbatim = { ...input, message: { ...input.message, sources: input.message.sources.map((source) => ({
    ...source, adjudication: { verbatim: true }, excerpt: 'Swami Replied:- This exact answer is copied word for word from the corpus.',
  })) } };
  assert.match(answerExportMarkdown(verbatim), /\*\*Exact answer from corpus\*\*/u);
  assert.match(answerExportText(verbatim), /Exact answer from corpus:/u);
  assert.match(answerExportHtml(verbatim), /Exact answer from corpus/u);
});

test('each assistant export is paired with its nearest preceding user question', async () => {
  const { questionForMessage } = await import('../src/ui/export.mjs');
  const messages = [
    { role: 'user', content: 'What is aspiration-less devotion?' },
    { role: 'assistant', content: 'First answer.' },
    { role: 'user', content: 'How does that apply to asking for a promotion?' },
    { role: 'assistant', content: 'Follow-up answer.' },
    { role: 'assistant', content: 'Regenerated follow-up answer.' },
  ];
  assert.equal(questionForMessage(messages, 1), 'What is aspiration-less devotion?');
  assert.equal(questionForMessage(messages, 3), 'How does that apply to asking for a promotion?');
  assert.equal(questionForMessage(messages, 4), 'How does that apply to asking for a promotion?');
});

test('complete-chat PDF document keeps every answer with its own exact citations', async () => {
  const { conversationExportHtml, conversationTurns } = await import('../src/ui/export.mjs');
  const messages = [
    { role: 'user', content: 'First question?' },
    { role: 'assistant', content: 'First answer. [1]', sources: [{ citationNumber: 1, title: 'First source', excerpt: 'Exact first supporting excerpt.', sourceAnswer: 'DO NOT EXPORT FIRST FULL DISCOURSE' }] },
    { role: 'user', content: 'Continuation question?' },
    { role: 'assistant', content: 'Second answer. [1]', sources: [{ citationNumber: 1, title: 'Second source', excerpt: 'Exact second supporting excerpt.', sourceAnswer: 'DO NOT EXPORT SECOND FULL DISCOURSE' }] },
  ];
  const turns = conversationTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].question, 'Continuation question?');
  assert.equal(turns[1].answers[0].content, 'Second answer. [1]');

  const html = conversationExportHtml({ title: 'Complete spiritual chat', messages });
  assert.match(html, /Conversation turn 1/u);
  assert.match(html, /First question\?/u);
  assert.match(html, /First answer\. <sup class="citation">\[1\]<\/sup>/u);
  assert.match(html, /Exact first supporting excerpt\./u);
  assert.match(html, /Conversation turn 2/u);
  assert.match(html, /Continuation question\?/u);
  assert.match(html, /Second answer\. <sup class="citation">\[1\]<\/sup>/u);
  assert.match(html, /Exact second supporting excerpt\./u);
  assert.doesNotMatch(html, /DO NOT EXPORT/u);
});
