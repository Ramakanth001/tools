const fs = require('node:fs');
const path = require('node:path');

const posGroups = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'pos_groups.json'), 'utf8'));

// 150 Reviewed Queries for Semantic Search Abstention & Confidence Benchmark
const rawQueries = [
  // ==========================================
  // 1. POSITIVE PARAPHRASES (50)
  // Paraphrases of authentic spiritual teachings in the corpus
  // ==========================================
  { id: 'pos-01', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1322', question: 'Can you tell me about the identity and nature of Shri Datta Swami?', rationale: 'Direct identity inquiry matching discourse:1322' },
  { id: 'pos-02', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:320', question: 'What is the procedure or location to have a personal meeting with Datta Swami?', rationale: 'Procedure for meeting Swami matching qa:320' },
  { id: 'pos-03', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:49', question: 'What constitutes the genuine intrinsic nature of Lord Dattatreya?', rationale: 'Real nature of Datta matching qa:49' },
  { id: 'pos-04', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:2068', question: 'How do the concepts of Lord Datta and Lord Dattatreya differ in spiritual knowledge?', rationale: 'Distinction between Datta and Dattatreya matching discourse:2068' },
  { id: 'pos-05', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:396', question: 'What spiritual technique does Swami suggest to overcome pornographic addiction?', rationale: 'Stopping pornography habit matching qa:396' },
  { id: 'pos-06', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:159', question: 'What is the reason God appears not to respond to our sincere prayers?', rationale: 'Unanswered prayers explanation matching qa:159' },
  { id: 'pos-07', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:60', question: 'Does the material universe possess objective reality or is it merely an illusion?', rationale: 'World reality vs illusion matching qa:60' },
  { id: 'pos-08', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:208', question: 'How can a devotee conquer fear and nervousness regarding childbirth and parenting?', rationale: 'Anxiety about having a child matching qa:208' },
  { id: 'pos-09', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:738', question: 'How does the human incarnation act as a two-in-one system of God and human medium?', rationale: 'Two-in-one nature of human incarnation matching discourse:738' },
  { id: 'pos-10', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:55', question: 'How can one recognise the contemporary human incarnation in this present world?', rationale: 'Recognising contemporary human incarnation matching qa:55' },
  { id: 'pos-11', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:5573', question: 'Why does human psychological weakness cause attraction toward unlawful sexual pleasure?', rationale: 'Lust and attraction analysis matching discourse:5573' },
  { id: 'pos-12', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:533', question: 'Why should a devotee perform deep spiritual analysis instead of blind devotional rituals?', rationale: 'Spiritual knowledge over blind ritualism matching discourse:533' },
  { id: 'pos-13', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:87', question: 'What is the relationship between the unimaginable God Parabrahman and the first energetic form Datta?', rationale: 'Unimaginable God and first incarnation matching qa:87' },
  { id: 'pos-14', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:380', question: 'Can energetic incarnations be directly perceived by humans on earth or only human incarnations?', rationale: 'Energetic vs human incarnation perception matching qa:380' },
  { id: 'pos-15', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:3501', question: 'What is the true significance of the three heads of Lord Dattatreya?', rationale: 'Significance of Brahma Vishnu Shiva in Datta matching discourse:3501' },
  { id: 'pos-16', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:766', question: 'How does continuous attachment to worldly desires lead to moral degradation and suffering?', rationale: 'Attachment leading to degradation matching discourse:766' },
  { id: 'pos-17', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:3034', question: 'Why does God delay granting the fruits of our desires when we pray to Him?', rationale: 'Divine timing and unanswered requests matching discourse:3034' },
  { id: 'pos-18', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:5497', question: 'How does Shankara explain that the world is relatively real to the soul while unreal to God?', rationale: 'Mithya and relative reality matching discourse:5497' },
  { id: 'pos-19', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:3191', question: 'What guidance does Swami give to pregnant women regarding mental peace and prayer?', rationale: 'Spiritual advice during pregnancy matching discourse:3191' },
  { id: 'pos-20', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:2528', question: 'How does the past karma of parents affect the birth and health of their progeny?', rationale: 'Karma affecting child birth matching discourse:2528' },
  { id: 'pos-21', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:737', question: 'Why is the human incarnation compared to electric current entering a wire?', rationale: 'Wire and current metaphor for incarnation matching discourse:737' },
  { id: 'pos-22', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:345', question: 'What is the role of miracles in spiritual path and why are they not the main goal?', rationale: 'Miracles role and limitations matching qa:345' },
  { id: 'pos-23', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:993', question: 'How does true spiritual knowledge generate genuine devotion and inspire practical sacrifice?', rationale: 'Jnana generating Bhakti and Karma Samnyasa matching discourse:993' },
  { id: 'pos-24', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1113', question: 'Can someone become a true disciple of Swami through knowledge even without meeting Him physically like Ekalavya?', rationale: 'Ekalavya example and disciple relation matching discourse:1113' },
  { id: 'pos-25', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1517', question: 'What is the definition of true love and devotion toward God without bargaining for benefits?', rationale: 'Unconditional devotion vs business devotion matching discourse:1517' },
  { id: 'pos-26', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:314', question: 'Why does human ego and jealousy prevent devotees from accepting the contemporary human incarnation?', rationale: 'Repulsion between common media matching qa:314' },
  { id: 'pos-27', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:2804', question: 'What is the difference between true spiritual service (karmaphala tyaga) and mere theoretical lip-service?', rationale: 'Practical sacrifice vs theoretical worship matching discourse:2804' },
  { id: 'pos-28', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:4318', question: 'How does God punish unrepentant sinners in hell to reform them?', rationale: 'Reformation through punishment in hell matching discourse:4318' },
  { id: 'pos-29', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1309', question: 'Why is sacrifice of the fruit of hard work considered the supreme test of devotion?', rationale: 'Karmaphala tyaga as acid test of love matching discourse:1309' },
  { id: 'pos-30', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1116', question: 'How can householders balance their domestic duties with spiritual pursuit without neglecting family?', rationale: 'Householder duty and spiritual pursuit matching discourse:1116' },
  { id: 'pos-31', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:453', question: 'What is the genuine purpose of rituals and mantras according to the ancient Vedas?', rationale: 'True Vedic meaning of rituals matching discourse:453' },
  { id: 'pos-32', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1504', question: 'How do past life sanskaras determine the spiritual inclinations of an individual in this life?', rationale: 'Sanskaras and spiritual tendencies matching discourse:1504' },
  { id: 'pos-33', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:476', question: 'What does the Gita mean when it says that sacrifice without expectation of fruit is true renunciation?', rationale: 'Gita interpretation of Karma Samnyasa matching discourse:476' },
  { id: 'pos-34', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:4214', question: 'Why is internal repentance and non-repetition of sin required before divine forgiveness can occur?', rationale: 'Reformation through repentance matching discourse:4214' },
  { id: 'pos-35', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1863', question: 'How does chanting the divine name with mental focus purify the mind from negative thoughts?', rationale: 'Name chanting and mental purity matching discourse:1863' },
  { id: 'pos-36', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:4321', question: 'Can astrology alter divine destiny or does it merely indicate the fruits of past karma?', rationale: 'Astrology as karma indicator matching discourse:4321' },
  { id: 'pos-37', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:2854', question: 'Where can devotees receive the printed discourses and spiritual books of Shri Datta Swami?', rationale: 'Availability of Swami publications matching discourse:2854' },
  { id: 'pos-38', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:3985', question: 'What should be the attitude of a disciple when entering the presence of the spiritual Master?', rationale: 'Disciple conduct before Guru matching discourse:3985' },
  { id: 'pos-39', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:5568', question: 'How does Datta incarnate in different religions under various names like Father of Heaven and Allah?', rationale: 'Universal spirituality across world religions matching discourse:5568' },
  { id: 'pos-40', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'qa:162', question: 'Why did Lord Krishna declare in the Bhagavad Gita that He alone is the ultimate goal of all paths?', rationale: 'Krishna declaration in Gita matching qa:162' },
  { id: 'pos-41', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:845', question: 'What is the inner spiritual meaning of the churning of the cosmic ocean (Samudra Manthana)?', rationale: 'Samudra Manthana allegorical interpretation matching discourse:845' },
  { id: 'pos-42', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:2781', question: 'Why did Lord Dattatreya choose twenty-four gurus from nature including the honeybee and python?', rationale: '24 gurus of Dattatreya in Bhagavata matching discourse:2781' },
  { id: 'pos-43', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:423', question: 'How does self-control (dama) and mental control (shama) help in conquering sensual cravings?', rationale: 'Shama and dama in conquering senses matching discourse:423' },
  { id: 'pos-44', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1019', question: 'What is the spiritual damage caused by engaging in illicit affairs and breaking marriage vows?', rationale: 'Adultery and moral consequences matching discourse:1019' },
  { id: 'pos-45', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:264', question: 'How does the grace of God operate to protect a devotee from past negative karma?', rationale: 'Grace and karma postponement matching discourse:264' },
  { id: 'pos-46', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:4193', question: 'Why do pure souls sometimes suffer intense physical illness and pain on earth?', rationale: 'Suffering of pure souls explained matching discourse:4193' },
  { id: 'pos-47', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:2335', question: 'Can devotion without surrender and obedience to divine commands please God?', rationale: 'Obedience as proof of surrender matching discourse:2335' },
  { id: 'pos-48', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:3108', question: 'What is the difference between awareness (chit) and inert energy (prana) in living beings?', rationale: 'Awareness vs energy distinction matching discourse:3108' },
  { id: 'pos-49', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1815', question: 'How does modern science affirm that matter and energy are mutually convertible like maya?', rationale: 'Matter-energy conversion and maya matching discourse:1815' },
  { id: 'pos-50', category: 'positive_paraphrase', shouldAbstain: false, expectedSourceId: 'discourse:1814', question: 'Why does human soul mistake itself for God in the state of deep sleep or waking state?', rationale: 'Advaita misunderstanding of soul as God matching discourse:1814' },

  // ==========================================
  // 2. LEXICAL TRAPS (25)
  // Queries where terms occur in separate/contrasting clauses or ask opposite questions
  // ==========================================
  { id: 'trap-01', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can an oil lamp heat an entire house in winter?', rationale: 'Clause trap: oil lamp + heat house' },
  { id: 'trap-02', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can an oil lamp cook rice or boil drinking water?', rationale: 'Clause trap: oil lamp + cook rice' },
  { id: 'trap-03', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can lighting an oil lamp cure diabetes or reduce blood sugar?', rationale: 'Clause trap: oil lamp + cure diabetes' },
  { id: 'trap-04', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can copper wire transmit spiritual vibrations to heal illness?', rationale: 'Clause trap: copper wire + transmit vibrations' },
  { id: 'trap-05', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can meditating on Lord Datta charge a lithium electric battery?', rationale: 'Clause trap: meditate + charge battery' },
  { id: 'trap-06', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can chanting mantras increase car engine mileage on the highway?', rationale: 'Clause trap: mantra + increase mileage' },
  { id: 'trap-07', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can holy ash extinguish a burning gasoline fire?', rationale: 'Clause trap: holy ash + extinguish gasoline' },
  { id: 'trap-08', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can lighting incense protect a building from lightning strikes?', rationale: 'Clause trap: incense + protect lightning' },
  { id: 'trap-09', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can a clay oil lamp replace electric bulbs in an operating theatre?', rationale: 'Clause trap: oil lamp + operating theatre' },
  { id: 'trap-10', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can performing puja clean toxic industrial effluent in a chemical river?', rationale: 'Clause trap: puja + clean effluent' },
  { id: 'trap-11', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can reciting the Gayatri mantra repair a punctured car tyre?', rationale: 'Clause trap: Gayatri mantra + repair tyre' },
  { id: 'trap-12', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can eating flowers from the altar substitute for insulin injections?', rationale: 'Clause trap: altar flowers + substitute insulin' },
  { id: 'trap-13', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can an oil lamp boil milk for making tea?', rationale: 'Clause trap: oil lamp + boil milk' },
  { id: 'trap-14', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can spiritual energy melt titanium metal in an industrial furnace?', rationale: 'Clause trap: spiritual energy + melt titanium' },
  { id: 'trap-15', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can burning camphor purify radioactive nuclear fallout?', rationale: 'Clause trap: camphor + purify fallout' },
  { id: 'trap-16', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can holy water sanitize surgical scalpels in an intensive care hospital?', rationale: 'Clause trap: holy water + sanitize scalpels' },
  { id: 'trap-17', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can deep meditation replace drinking water in the Sahara desert?', rationale: 'Clause trap: meditation + replace water' },
  { id: 'trap-18', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can chanting hymns weld broken steel beams in a collapsed skyscraper?', rationale: 'Clause trap: chanting hymns + weld steel' },
  { id: 'trap-19', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can a clay oil lamp power an electric refrigerator in summer?', rationale: 'Clause trap: clay lamp + power refrigerator' },
  { id: 'trap-20', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can coconut water be used as engine motor oil in a commercial truck?', rationale: 'Clause trap: coconut water + motor oil' },
  { id: 'trap-21', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can holy basil leaves cure bacterial tuberculosis without antibiotics?', rationale: 'Clause trap: holy basil + cure tuberculosis' },
  { id: 'trap-22', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can meditating in the sun replace sunscreen against UV radiation?', rationale: 'Clause trap: meditating + replace sunscreen' },
  { id: 'trap-23', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can an oil lamp illuminate an entire football stadium at night?', rationale: 'Clause trap: oil lamp + illuminate stadium' },
  { id: 'trap-24', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can chanting Sanskrit verses decode encrypted computer passwords?', rationale: 'Clause trap: Sanskrit verses + decode passwords' },
  { id: 'trap-25', category: 'lexical_trap', shouldAbstain: true, expectedSourceId: null, question: 'Can burning cow dung cakes power an electric passenger train?', rationale: 'Clause trap: cow dung + power train' },

  // ==========================================
  // 3. PHYSICAL TASKS, MEASUREMENTS & RECIPES (25)
  // Non-corpus practical tasks, recipes, temperatures, technical procedures
  // ==========================================
  { id: 'phys-01', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How do I bake a moist chocolate fudge cake from scratch in an oven?', rationale: 'Cooking recipe absent from corpus' },
  { id: 'phys-02', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What is the exact temperature and boiling point of sesame oil in Celsius?', rationale: 'Physical measurement absent from corpus' },
  { id: 'phys-03', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How many lumens of brightness does a standard cotton-wick clay oil lamp produce?', rationale: 'Photometric measurement absent from corpus' },
  { id: 'phys-04', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What dosage of ibuprofen and paracetamol is safe for a child weighing 20 kilograms?', rationale: 'Medical pediatric dosage absent from corpus' },
  { id: 'phys-05', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How do I replace the alternator on a 2018 Honda Civic sedan?', rationale: 'Automotive repair absent from corpus' },
  { id: 'phys-06', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What is the recipe and cooking time for authentic Hyderabadi mutton dum biryani?', rationale: 'Culinary recipe absent from corpus' },
  { id: 'phys-07', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How to solder surface-mount microchips onto an electronic printed circuit board?', rationale: 'Electronics engineering absent from corpus' },
  { id: 'phys-08', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What is the electrical resistance and wattage of a 100-watt tungsten filament bulb?', rationale: 'Electrical physics absent from corpus' },
  { id: 'phys-09', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How do I troubleshoot a leaking copper water pipe under a kitchen sink?', rationale: 'Plumbing repair absent from corpus' },
  { id: 'phys-10', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What are the steps to calibrate a gas chromatography mass spectrometer in a chemical lab?', rationale: 'Laboratory procedure absent from corpus' },
  { id: 'phys-11', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How to knit a woolen sweater for winter using circular knitting needles?', rationale: 'Craft procedure absent from corpus' },
  { id: 'phys-12', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What is the cure and treatment protocol for bacterial pneumonia in elderly patients?', rationale: 'Medical clinical treatment absent from corpus' },
  { id: 'phys-13', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How to install a dual-boot Ubuntu Linux alongside Windows 11 on an NVMe SSD?', rationale: 'Software installation absent from corpus' },
  { id: 'phys-14', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What is the compressive strength of C30 concrete after 28 days of curing in MPa?', rationale: 'Civil engineering specification absent from corpus' },
  { id: 'phys-15', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How do I brew homemade espresso coffee using a manual lever machine?', rationale: 'Beverage preparation absent from corpus' },
  { id: 'phys-16', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What is the correct tire pressure in PSI for a Toyota RAV4 during hot summer?', rationale: 'Vehicle maintenance absent from corpus' },
  { id: 'phys-17', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How to cultivate hydroponic tomatoes in an indoor greenhouse with nutrient solutions?', rationale: 'Agricultural procedure absent from corpus' },
  { id: 'phys-18', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What is the chemical composition and shelf life of lithium-ion NMC batteries?', rationale: 'Chemical engineering absent from corpus' },
  { id: 'phys-19', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How do I tune a six-string acoustic guitar to open D tuning?', rationale: 'Musical instrument tuning absent from corpus' },
  { id: 'phys-20', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What are the symptoms and blood glucose threshold for diagnosing Type 2 Diabetes?', rationale: 'Medical diagnostic criteria absent from corpus' },
  { id: 'phys-21', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How to mix epoxy resin and hardener to coat a wooden dining table without bubbles?', rationale: 'Woodworking task absent from corpus' },
  { id: 'phys-22', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What is the aerodynamic drag coefficient of a Boeing 787 Dreamliner at cruising speed?', rationale: 'Aeronautical engineering absent from corpus' },
  { id: 'phys-23', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How do I remove stubborn red wine stains from white cotton tablecloth fabric?', rationale: 'Housekeeping cleaning task absent from corpus' },
  { id: 'phys-24', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'What are the camera exposure settings for photographing the Milky Way at night?', rationale: 'Photography settings absent from corpus' },
  { id: 'phys-25', category: 'physical_and_recipes', shouldAbstain: true, expectedSourceId: null, question: 'How to properly season a cast iron skillet using flaxseed oil in an oven?', rationale: 'Cookware maintenance absent from corpus' },

  // ==========================================
  // 4. GENERAL KNOWLEDGE & CURRENT EVENTS (20)
  // Geography, history, science, world affairs
  // ==========================================
  { id: 'gen-01', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the official capital city of the French Republic?', rationale: 'World geography absent from corpus' },
  { id: 'gen-02', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'Which national football team won the 2022 FIFA World Cup final in Qatar?', rationale: 'Sports history absent from corpus' },
  { id: 'gen-03', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'In what year was the United Nations Charter signed in San Francisco?', rationale: 'Modern world history absent from corpus' },
  { id: 'gen-04', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the equatorial diameter and orbital period of the planet Saturn?', rationale: 'Astronomy planetary data absent from corpus' },
  { id: 'gen-05', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'Who served as the first democratically elected president of South Africa in 1994?', rationale: 'Political history absent from corpus' },
  { id: 'gen-06', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the chemical formula and molar mass of sodium chloride table salt?', rationale: 'Inorganic chemistry absent from corpus' },
  { id: 'gen-07', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the estimated human population of the Tokyo metropolitan area?', rationale: 'Demographic statistics absent from corpus' },
  { id: 'gen-08', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'Who wrote the play Romeo and Juliet in Elizabethan England?', rationale: 'English literature absent from corpus' },
  { id: 'gen-09', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the longest river system on the continent of South America?', rationale: 'Physical geography absent from corpus' },
  { id: 'gen-10', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'Which country won the Eurovision Song Contest in the year 2023?', rationale: 'Entertainment trivia absent from corpus' },
  { id: 'gen-11', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the currency and central bank of the United Kingdom?', rationale: 'Economics currency data absent from corpus' },
  { id: 'gen-12', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'When did the Berlin Wall fall, leading to German reunification?', rationale: 'European history absent from corpus' },
  { id: 'gen-13', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the speed of light in vacuum measured in meters per second?', rationale: 'Fundamental physical constant absent from corpus' },
  { id: 'gen-14', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'Which artist painted the famous Renaissance portrait known as the Mona Lisa?', rationale: 'Art history absent from corpus' },
  { id: 'gen-15', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the tallest mountain peak in North America above sea level?', rationale: 'Geographical landmarks absent from corpus' },
  { id: 'gen-16', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'Who discovered penicillin and revolutionized antibiotic medicine?', rationale: 'History of medicine absent from corpus' },
  { id: 'gen-17', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the main operating system kernel developed by Linus Torvalds in 1991?', rationale: 'Computer science history absent from corpus' },
  { id: 'gen-18', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'Which treaty ended World War I between the Allied powers and Germany in 1919?', rationale: 'World War history absent from corpus' },
  { id: 'gen-19', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the primary language spoken in the South American nation of Brazil?', rationale: 'Linguistics geography absent from corpus' },
  { id: 'gen-20', category: 'general_knowledge', shouldAbstain: true, expectedSourceId: null, question: 'What is the deepest oceanic trench on planet Earth called?', rationale: 'Oceanography absent from corpus' },

  // ==========================================
  // 5. UNANSWERED SPIRITUAL QUESTIONS (15)
  // Specific doctrines, texts, or traditions not addressed in Swami corpus
  // ==========================================
  { id: 'unans-01', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What does the Book of Mormon teach about the ancient migration of the Jaredites across the ocean?', rationale: 'Latter-day Saint scripture absent from corpus' },
  { id: 'unans-02', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'How does the First Vatican Council define the conditions for Papal Infallibility ex cathedra?', rationale: 'Catholic canon law specifics absent from corpus' },
  { id: 'unans-03', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What are the auditing levels of the Operating Thetan bridge in Scientology doctrine?', rationale: 'Scientology theology absent from corpus' },
  { id: 'unans-04', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What are the rules of ritual purification at a Shinto shrine temizuya water pavilion in Japan?', rationale: 'Shinto liturgical ritual absent from corpus' },
  { id: 'unans-05', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'How do Calvinist theologians explain the Five Points of TULIP predestination theology?', rationale: 'Reformed Protestant dogma absent from corpus' },
  { id: 'unans-06', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What does the Tibetan Book of the Dead teach about the Bardo of the intermediate state between rebirths?', rationale: 'Tibetan Bardo teachings specific texts absent from corpus' },
  { id: 'unans-07', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What is the Zoroastrian teaching regarding the Chinvat Bridge and the Daena maiden after death?', rationale: 'Zoroastrian eschatology absent from corpus' },
  { id: 'unans-08', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What are the specific dietary laws of Kashrut regarding kosher slaughtering and milk-meat separation in the Talmud?', rationale: 'Rabbinic Talmudic halakha absent from corpus' },
  { id: 'unans-09', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What does the Daoist text Daodejing say about the uncarved block (Pu) in chapter 28?', rationale: 'Daoist textual verse commentary absent from corpus' },
  { id: 'unans-10', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'How does Baháʼí Faith explain the dispensation of the Báb in Shiraz in 1844?', rationale: 'Baha’i historical dispensation absent from corpus' },
  { id: 'unans-11', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What are the seven chakras according to the specific 10th-century Kubjikamata Tantra manuscript?', rationale: 'Medieval Shakta tantric manuscript specifics absent from corpus' },
  { id: 'unans-12', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What is the Jain philosophical doctrine of Syadvada and sevenfold predication (saptabhangi)?', rationale: 'Technical Jain epistemology absent from corpus' },
  { id: 'unans-13', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What are the requirements for initiation into the Eleusinian mysteries of Demeter in ancient Greece?', rationale: 'Ancient Hellenic mystery cults absent from corpus' },
  { id: 'unans-14', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What does the Sikh scripture Guru Granth Sahib say in the Japji Sahib about the realm of truth (Sach Khand)?', rationale: 'Sikh Japji Sahib stanza specifics absent from corpus' },
  { id: 'unans-15', category: 'unanswered_spiritual', shouldAbstain: true, expectedSourceId: null, question: 'What is the Swedenborgian teaching regarding spiritual correspondences between heaven and human anatomy?', rationale: 'Swedenborgian esoteric anatomy absent from corpus' },

  // ==========================================
  // 6. NOISY & TRANSLITERATED QUESTIONS (15)
  // Colloquial, misspelled, or noisy queries (some positive, some negative/gibberish)
  // ==========================================
  { id: 'noisy-01', category: 'noisy_and_transliterated', shouldAbstain: false, expectedSourceId: 'discourse:1322', relevantSourceGroups: ['discourse:1322', 'discourse:737', 'qa:320'], question: 'who is shree datta swamy', rationale: 'Noisy transliterated spelling of core positive query' },
  { id: 'noisy-02', category: 'noisy_and_transliterated', shouldAbstain: false, expectedSourceId: 'qa:320', relevantSourceGroups: ['qa:320', 'discourse:2854'], question: 'where to meet dattswami in vijayawada or hyderabad', rationale: 'Colloquial phrasing of meeting Swami matching qa:320' },
  { id: 'noisy-03', category: 'noisy_and_transliterated', shouldAbstain: false, expectedSourceId: 'qa:396', relevantSourceGroups: ['qa:396', 'discourse:4531'], question: 'how to stop waching pron habit spiritually', rationale: 'Misspelled addiction query matching qa:396' },
  { id: 'noisy-04', category: 'noisy_and_transliterated', shouldAbstain: false, expectedSourceId: 'qa:159', relevantSourceGroups: ['qa:159', 'discourse:4513'], question: 'why god doesnt anser my daily prayrs', rationale: 'Colloquial unanswered prayers matching qa:159' },
  { id: 'noisy-05', category: 'noisy_and_transliterated', shouldAbstain: false, expectedSourceId: 'discourse:2068', relevantSourceGroups: ['discourse:2068', 'discourse:3501'], question: 'diference between lord datta and dathatreya', rationale: 'Misspelled distinction query matching discourse:2068' },
  { id: 'noisy-06', category: 'noisy_and_transliterated', shouldAbstain: false, expectedSourceId: 'discourse:738', relevantSourceGroups: ['discourse:738', 'discourse:1787'], question: 'two in one system of human incarnation explantion', rationale: 'Informal fragment query matching discourse:738' },
  { id: 'noisy-07', category: 'noisy_and_transliterated', shouldAbstain: false, expectedSourceId: 'qa:60', relevantSourceGroups: ['qa:60', 'discourse:1814'], question: 'is this jagat world real or maya illusion according to swami', rationale: 'Mixed transliterated Sanskrit query matching qa:60' },
  { id: 'noisy-08', category: 'noisy_and_transliterated', shouldAbstain: false, expectedSourceId: 'discourse:1113', relevantSourceGroups: ['discourse:1113', 'discourse:999'], question: 'can ekalavya type disciple learn without seeing guru swami', rationale: 'Noisy question matching discourse:1113' },
  { id: 'noisy-09', category: 'noisy_and_transliterated', shouldAbstain: false, expectedSourceId: 'qa:345', relevantSourceGroups: ['qa:345', 'discourse:296'], question: 'why swami doesnt do mirakles everywhere now', rationale: 'Noisy miracles query matching qa:345' },
  { id: 'noisy-10', category: 'noisy_and_transliterated', shouldAbstain: true, expectedSourceId: null, question: 'asdf qwer zxcv poiuy lkjhg', rationale: 'Complete keyboard mash noise must abstain' },
  { id: 'noisy-11', category: 'noisy_and_transliterated', shouldAbstain: true, expectedSourceId: null, question: 'xyzzy plugh 1234567890 !@#$', rationale: 'Gibberish symbols must abstain' },
  { id: 'noisy-12', category: 'noisy_and_transliterated', shouldAbstain: true, expectedSourceId: null, question: 'swami god datta bla bla bla nonsense word salad random text', rationale: 'Spiritual keyword stuffing noise must abstain' },
  { id: 'noisy-13', category: 'noisy_and_transliterated', shouldAbstain: true, expectedSourceId: null, question: 'can a lamp heat a cake temperature degrees celsius 100 200', rationale: 'Physical keyword noise mash must abstain' },
  { id: 'noisy-14', category: 'noisy_and_transliterated', shouldAbstain: true, expectedSourceId: null, question: 'qwertyuiop asdfghjkl zxcvbnm', rationale: 'Alphabet keyboard walk must abstain' },
  { id: 'noisy-15', category: 'noisy_and_transliterated', shouldAbstain: true, expectedSourceId: null, question: 'paracetamol dosage for baking cake in oil lamp', rationale: 'Nonsensical cross-domain hallucination trap must abstain' },
];

// Enrich positive queries with relevantSourceGroups from posGroups
const queries = rawQueries.map((q) => {
  if (!q.shouldAbstain) {
    const groups = [...new Set([q.expectedSourceId, ...(q.relevantSourceGroups || []), ...(posGroups[q.id] || [])].filter(Boolean))];
    return { ...q, relevantSourceGroups: groups };
  }
  return q;
});

function buildBenchmark() {
  const categories = {};
  for (const q of queries) {
    categories[q.category] = (categories[q.category] || 0) + 1;
  }
  console.log('Category distribution:', categories);
  console.log('Total queries:', queries.length);

  if (categories.positive_paraphrase !== 50) throw new Error(`Expected 50 positive paraphrases, got ${categories.positive_paraphrase}`);
  if (categories.lexical_trap !== 25) throw new Error(`Expected 25 lexical traps, got ${categories.lexical_trap}`);
  if (categories.physical_and_recipes !== 25) throw new Error(`Expected 25 physical/recipes, got ${categories.physical_and_recipes}`);
  if (categories.general_knowledge !== 20) throw new Error(`Expected 20 general knowledge, got ${categories.general_knowledge}`);
  if (categories.unanswered_spiritual !== 15) throw new Error(`Expected 15 unanswered spiritual, got ${categories.unanswered_spiritual}`);
  if (categories.noisy_and_transliterated !== 15) throw new Error(`Expected 15 noisy, got ${categories.noisy_and_transliterated}`);
  if (queries.length !== 150) throw new Error(`Expected 150 total queries, got ${queries.length}`);

  const train = [];
  const tune = [];
  const testSealed = [];

  const grouped = {};
  for (const q of queries) {
    if (!grouped[q.category]) grouped[q.category] = [];
    grouped[q.category].push(q);
  }

  for (const [category, items] of Object.entries(grouped)) {
    const n = items.length;
    const trainCount = Math.round(n * 0.60);
    const tuneCount = Math.round(n * 0.20);

    items.forEach((item, index) => {
      let split;
      if (index < trainCount) {
        split = 'train';
        train.push(item);
      } else if (index < trainCount + tuneCount) {
        split = 'tune';
        tune.push(item);
      } else {
        split = 'test_sealed';
        testSealed.push(item);
      }
      item.split = split;
    });
  }

  console.log(`Split breakdown: train=${train.length} (60%), tune=${tune.length} (20%), test_sealed=${testSealed.length} (20%)`);

  const frozenDir = path.join(__dirname, '..', 'benchmark', 'frozen');
  fs.mkdirSync(frozenDir, { recursive: true });

  const completePath = path.join(frozenDir, 'held_out_150_queries.json');
  const trainPath = path.join(frozenDir, 'held_out_150_train.json');
  const tunePath = path.join(frozenDir, 'held_out_150_tune.json');
  const testPath = path.join(frozenDir, 'held_out_150_test_sealed.json');

  fs.writeFileSync(completePath, `${JSON.stringify({ benchmarkVersion: 1, totalCases: queries.length, queries }, null, 2)}\n`);
  fs.writeFileSync(trainPath, `${JSON.stringify({ benchmarkVersion: 1, split: 'train', cases: train.length, queries: train }, null, 2)}\n`);
  fs.writeFileSync(tunePath, `${JSON.stringify({ benchmarkVersion: 1, split: 'tune', cases: tune.length, queries: tune }, null, 2)}\n`);
  fs.writeFileSync(testPath, `${JSON.stringify({ benchmarkVersion: 1, split: 'test_sealed', cases: testSealed.length, queries: testSealed }, null, 2)}\n`);

  console.log('Saved benchmark files:');
  console.log('-', completePath);
  console.log('-', trainPath);
  console.log('-', tunePath);
  console.log('-', testPath);
}

if (require.main === module) {
  buildBenchmark();
}

module.exports = { queries, buildBenchmark };
