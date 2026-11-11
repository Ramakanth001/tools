# 100-Query Distance-Based Search Evaluation Benchmark Report

> **Corpus:** `universal_qa_v2` (6,010 discourses | ~45M characters)  
> **Engine:** PostgreSQL 16 GIN Candidate Retrieval + Distance Rescoring  
> **Evaluation Scope:** 100 diverse, natural spiritual inquiries across 10 theological domains  
> **Date:** 2026-11-11T15:09:46.314Z  

## 1. Executive Summary Metrics

| Metric | Result | Target / Standard |
| :--- | :--- | :--- |
| **Mean Reciprocal Rank (MRR)** | **`0.903`** | &gt; 0.850 |
| **Top-1 Target Retrieval Accuracy** | **`87.0%`** (87/100) | &gt; 80.0% |
| **Top-5 Target Retrieval Rate** | **`95.0%`** (95/100) | &gt; 90.0% |
| **Top-10 Target Retrieval Rate** | **`98.0%`** (98/100) | &gt; 95.0% |
| **Top-35 Overall Corpus Recall** | **`100.0%`** (100/100) | &gt; 95.0% |

## 2. Latency Distribution across 100 Queries

| Percentile | Latency (ms) |
| :--- | :--- |
| **Minimum** | `1086.0 ms` |
| **p50 (Median)** | `3596.3 ms` |
| **p75** | `4856.5 ms` |
| **p90** | `5878.8 ms` |
| **p95** | `6039.2 ms` |
| **p99** | `6724.7 ms` |
| **Maximum** | `6724.7 ms` |
| **Mean Average** | `3546.9 ms` |

## 3. Breakdown by Theological Domain

| Domain | Queries | Top-1 Accuracy | Top-5 Rate | Median Latency (p50) |
| :--- | :---: | :---: | :---: | :---: |
| **Gayatri Mantra & Rituals** | 10 | 90.0% | 100.0% | 1596.6 ms |
| **Upanayanam & Rituals** | 10 | 100.0% | 100.0% | 1711.2 ms |
| **Vedantic Philosophy** | 10 | 90.0% | 90.0% | 3406.7 ms |
| **Human Incarnation** | 10 | 90.0% | 100.0% | 4413.3 ms |
| **Pravritti & Nivritti** | 10 | 60.0% | 90.0% | 5225.6 ms |
| **Bhakti Yoga** | 10 | 80.0% | 90.0% | 4181.4 ms |
| **Karma Yoga & Sacrifice** | 10 | 90.0% | 100.0% | 4890.2 ms |
| **Law of Karma** | 10 | 70.0% | 80.0% | 3634.7 ms |
| **Universal Religion** | 10 | 100.0% | 100.0% | 4044.0 ms |
| **Ethics & Society** | 10 | 100.0% | 100.0% | 3596.3 ms |

## 4. Full Query-by-Query Retrieval Log

| # | Domain | Query | Top #1 Retrieved Discourse | Target Hit Rank | Latency | Status |
| :-: | :--- | :--- | :--- | :-: | :-: | :-: |
| **Q001** | Gayatri Mantra & Rituals | `what is the real meaning of Gayatri mantra?` | Clarifications on Gayathri Mantra | **#1** | 2459.7 ms | ✅ PASS (Top 1) |
| **Q002** | Gayatri Mantra & Rituals | `Gāyatrī mantra` | Clarifications on Gayathri Mantra | **#1** | 1086.0 ms | ✅ PASS (Top 1) |
| **Q003** | Gayatri Mantra & Rituals | `Is Gayatri a Vedic meter or a specific deity?` | Is it wrong to take Savitha Deavatha to be Adiparaashakti in Gayathri mantra? | **#1** | 3225.8 ms | ✅ PASS (Top 1) |
| **Q004** | Gayatri Mantra & Rituals | `Can women chant the Gayatri mantra?` | If women chant the Gayatri Mantra continuously, does it affect their physical health? | **#1** | 1226.6 ms | ✅ PASS (Top 1) |
| **Q005** | Gayatri Mantra & Rituals | `Is the so-called Gayatri Mantra actually the Savitri Mantra?` | Is the so-called Gayatri Mantra, actually the Savitri Mantra? | **#1** | 3037.2 ms | ✅ PASS (Top 1) |
| **Q006** | Gayatri Mantra & Rituals | `what is the real meaning of Sandhyavandanam?` | What is the importance of Sandhyaa Vandanam? | **#1** | 2151.6 ms | ✅ PASS (Top 1) |
| **Q007** | Gayatri Mantra & Rituals | `What is the importance of Sandhyaa Vandanam?` | What is the importance of Sandhyaa Vandanam? | **#1** | 1177.6 ms | ✅ PASS (Top 1) |
| **Q008** | Gayatri Mantra & Rituals | `Can a cinema song become the Gayatri Mantra?` | Can a cinema song, when diverted to the Lord, become the Gayatri Mantra? | **#1** | 1505.5 ms | ✅ PASS (Top 1) |
| **Q009** | Gayatri Mantra & Rituals | `Adiparaashakti relationship with Savita devatha` | Is it wrong to take Savitha Deavatha to be Adiparaashakti in Gayathri mantra? | **#1** | 1596.6 ms | ✅ PASS (Top 1) |
| **Q010** | Gayatri Mantra & Rituals | `meaning of the upasthana mantras chanted in Sandhyavandana` | What is the real meaning of Mantra Pushpam which is chanted at the end of every pooja? | **#2** | 1292.7 ms | ✅ PASS (Top 5) |
| **Q011** | Upanayanam & Rituals | `what is the real meaning of Upanayanam?` | Upanayanam (The Holy Thread Marriage) - Part-1 | **#1** | 1571.2 ms | ✅ PASS (Top 1) |
| **Q012** | Upanayanam & Rituals | `significance of three strings in holy cross belt in Upanayanam` | What is the significance of the three strings present in the holy cross belt put in the Upanayanam ritual? | **#1** | 1655.2 ms | ✅ PASS (Top 1) |
| **Q013** | Upanayanam & Rituals | `What is the true inner meaning of Yajna or sacrifice?` | Trailokya Gita: Chapter-15: Yajna Vichaara Yoga (The Association of the Enquiry of Sacrifice) | **#1** | 2858.3 ms | ✅ PASS (Top 1) |
| **Q014** | Upanayanam & Rituals | `Why do we burn valuable food and ghee in physical fire during Yajna?` | Understanding the authorities from scriptures on burning of ghee in a physical fire | **#1** | 2374.7 ms | ✅ PASS (Top 1) |
| **Q015** | Upanayanam & Rituals | `What is the real symbolism of temples and ritual worship?` | SYMBOLISM OF TEMPLES AND RITUALS | **#1** | 2692.5 ms | ✅ PASS (Top 1) |
| **Q016** | Upanayanam & Rituals | `Why is idol worship or Pratika Upasana practiced in Hinduism?` | Is there any reference to idol worship in the Veda? | **#1** | 1713.8 ms | ✅ PASS (Top 1) |
| **Q017** | Upanayanam & Rituals | `Is the sacred thread Yajnopavitam restricted by caste or gender?` | Upanayanam (The Holy Thread Marriage) - Part-1 | **#1** | 1610.6 ms | ✅ PASS (Top 1) |
| **Q018** | Upanayanam & Rituals | `Can a person perform spiritual rituals without knowing the meaning of mantras?` | Can You please explain the meaning of Mahamrityunjaya Mantra? | **#1** | 1711.2 ms | ✅ PASS (Top 1) |
| **Q019** | Upanayanam & Rituals | `What is the purpose of ringing bells and lighting camphor during Arati?` | Swami answers questions of Smt. Arati | **#1** | 1475.1 ms | ✅ PASS (Top 1) |
| **Q020** | Upanayanam & Rituals | `Should spiritual seekers perform Shraddha ceremony for departed ancestors?` | Do we need to perform rituals every year for the departed souls? | **#1** | 1474.7 ms | ✅ PASS (Top 1) |
| **Q021** | Vedantic Philosophy | `true interpretation of Shankara Advaita philosophy` | Don't You think Advaita philosophy is a good attraction and encouragement for a beginner in-spirituality? | **#1** | 5647.2 ms | ✅ PASS (Top 1) |
| **Q022** | Vedantic Philosophy | `Why did Shankara say that the individual soul is God Himself?` | Why Is Every Soul Not God? Part-1 | **#1** | 6132.1 ms | ✅ PASS (Top 1) |
| **Q023** | Vedantic Philosophy | `Why is there a contradiction between the philosophies of Shankara, Ramanuja and Madhva?` | Why is there a contradiction between the philosophies of Shankara, Ramanuja and Madhva? | **#1** | 5952.9 ms | ✅ PASS (Top 1) |
| **Q024** | Vedantic Philosophy | `What is the difference between Maya and Mula Maya?` | MAYA AND MULA MAYA | **#1** | 2944.4 ms | ✅ PASS (Top 1) |
| **Q025** | Vedantic Philosophy | `Is the world real or unreal according to Mithya?` | Is this world real or unreal? | **#1** | 1257.3 ms | ✅ PASS (Top 1) |
| **Q026** | Vedantic Philosophy | `What is the nature of the Unimaginable God or Parabrahman?` | PARABRAHMA PANCHAKAM (The Unimaginable God) | **#1** | 4879.0 ms | ✅ PASS (Top 1) |
| **Q027** | Vedantic Philosophy | `How does pure awareness differ from the ultimate Creator God?` | God As The Creator In Vedanta | **#1** | 3406.7 ms | ✅ PASS (Top 1) |
| **Q028** | Vedantic Philosophy | `What is the concept of vivartavada vs parinamavada?` | MODELS AND THE CONCEPT | **#10** | 2275.0 ms | ⚠️ HIT (Top 10) |
| **Q029** | Vedantic Philosophy | `How does Datta Swami correlate Advaita, Vishishtadvaita and Dvaita?` | What is the united meaning of Advaita, Vishishtadvaita and Dvaita? | **#1** | 2231.5 ms | ✅ PASS (Top 1) |
| **Q030** | Vedantic Philosophy | `Can the individual soul ever become the absolute Creator of the universe?` | SOUL IS NOT THE CREATOR | **#1** | 3307.1 ms | ✅ PASS (Top 1) |
| **Q031** | Human Incarnation | `What is the real identity mark for recognizing the human incarnation of the Lord?` | What is the real identity mark for recognizing the human incarnation of the Lord? | **#1** | 4105.9 ms | ✅ PASS (Top 1) |
| **Q032** | Human Incarnation | `Why is the worship of a human incarnation better than that of a statue?` | Why is the worship of a human incarnation better than that of a statue? | **#1** | 4327.7 ms | ✅ PASS (Top 1) |
| **Q033** | Human Incarnation | `Why do people easily accept past incarnations but neglect the contemporary human incarnation?` | When people are spiritually very advanced, will they not accept contemporary human incarnations? | **#1** | 3164.0 ms | ✅ PASS (Top 1) |
| **Q034** | Human Incarnation | `How to distinguish between Sadguru and Guru?` | How to distinguish between Sadguru and Guru? | **#1** | 4413.3 ms | ✅ PASS (Top 1) |
| **Q035** | Human Incarnation | `What are the causes for failing in the tests of Lord Datta?` | Why is the human incarnation of God not easily accepted? What are the causes for failing in the tests of Datta? | **#1** | 1286.8 ms | ✅ PASS (Top 1) |
| **Q036** | Human Incarnation | `How does God enter into the human body to become an Incarnation?` | Datta Veda - Chapter-5 Part-2: Human Incarnation of The Unimaginable God | **#5** | 4350.9 ms | ✅ PASS (Top 5) |
| **Q037** | Human Incarnation | `Can two contemporary human incarnations exist at the same time?` | When people are spiritually very advanced, will they not accept contemporary human incarnations? | **#1** | 4551.6 ms | ✅ PASS (Top 1) |
| **Q038** | Human Incarnation | `Why did Lord Krishna act like an ordinary human being at times?` | THE SECRET BEHIND LORD KRISHNA'S ROMANCE | **#1** | 4691.5 ms | ✅ PASS (Top 1) |
| **Q039** | Human Incarnation | `What is the role of miracles performed by the Human Incarnation?` | Are the video recordings of the miracles performed by Shri Satya Sai Baba direct proof of the existence of the unimaginable God? | **#1** | 5981.4 ms | ✅ PASS (Top 1) |
| **Q040** | Human Incarnation | `How to avoid ego and jealousy towards the contemporary human incarnation?` | Can the public criticise the contemporary human incarnation because of jealousy? | **#1** | 5535.5 ms | ✅ PASS (Top 1) |
| **Q041** | Pravritti & Nivritti | `difference between pravritti and nivritti` | MAINTAINING NIVRITTI AND PRAVRITTI SIMULTANEOUSLY | **#1** | 5511.3 ms | ✅ PASS (Top 1) |
| **Q042** | Pravritti & Nivritti | `Is Nivritti mandatory for all human beings or only an option?` | MAINTAINING NIVRITTI AND PRAVRITTI SIMULTANEOUSLY | **#2** | 1824.5 ms | ✅ PASS (Top 5) |
| **Q043** | Pravritti & Nivritti | `Why does God always discourage devotees from taking up Nivritti?` | Does God Datta help the devotees in nivrutti or not? | **#2** | 4856.5 ms | ✅ PASS (Top 5) |
| **Q044** | Pravritti & Nivritti | `How to balance worldly family responsibilities with spiritual devotion?` | Why are all the worldly responsibilities only on women? | **#1** | 1296.5 ms | ✅ PASS (Top 1) |
| **Q045** | Pravritti & Nivritti | `What happens if someone fails in Pravritti while pursuing Nivritti?` | MAINTAINING NIVRITTI AND PRAVRITTI SIMULTANEOUSLY | **#1** | 5379.3 ms | ✅ PASS (Top 1) |
| **Q046** | Pravritti & Nivritti | `What are the three strongest worldly bonds described as Eshanas?` | Shri RaadhaaKrishna Gita - Anu Gita: Chapter-1: The Association of Enquiry of the Three Strongest Worldly Bonds (Verses 20-43) | **#1** | 5085.6 ms | ✅ PASS (Top 1) |
| **Q047** | Pravritti & Nivritti | `How did Gopikas conquer all worldly bonds in Nivritti?` | Please enlighten me about various bonds in Pravrutti and Nivrutti in the light of the three tests. | **#1** | 5472.2 ms | ✅ PASS (Top 1) |
| **Q048** | Pravritti & Nivritti | `Is justice in Pravritti rewarded with heaven or spiritual liberation?` | Why does God give more importance to following justice in worldly life (pravrutti) than developing d | **#1** | 6695.5 ms | ✅ PASS (Top 1) |
| **Q049** | Pravritti & Nivritti | `Can a person achieve God while cheating people in society?` | Brahmana is the Person Leading Society Towards God Through Spiritual Preaching | **#5** | 3782.1 ms | ✅ PASS (Top 5) |
| **Q050** | Pravritti & Nivritti | `Why did Rama prioritize Pravritti while Krishna showed Nivritti?` | MAINTAINING NIVRITTI AND PRAVRITTI SIMULTANEOUSLY | **#29** | 5225.6 ms | ⚠️ HIT (Top 35) |
| **Q051** | Bhakti Yoga | `what is the highest form of Bhakti?` | Which is highest among Jnaana, Bhakti and Karma Yogas? | **#1** | 5451.3 ms | ✅ PASS (Top 1) |
| **Q052** | Bhakti Yoga | `What is the relationship between spiritual knowledge, devotion, and practice?` | Spiritual knowledge leads to devotion, which in turn, leads to aspiration-free service and sacrifice | **#1** | 5875.3 ms | ✅ PASS (Top 1) |
| **Q053** | Bhakti Yoga | `Can emotion or crying in front of God be considered genuine devotion?` | PROTECTION OF GOD DOES NOT COME BY PRAYING OR CRYING | **#1** | 4028.3 ms | ✅ PASS (Top 1) |
| **Q054** | Bhakti Yoga | `What is Madhura Bhakti and how is it misinterpreted regarding Radha and Krishna?` | Are females more fortunate than males because they have the opportunity to show Madhura Bhakti? | **#1** | 4314.6 ms | ✅ PASS (Top 1) |
| **Q055** | Bhakti Yoga | `Why is devotion towards God often selfish and business-minded?` | Classification of devotion to God | **#1** | 3805.5 ms | ✅ PASS (Top 1) |
| **Q056** | Bhakti Yoga | `How did Hanuman represent the pinnacle of selfless devotional service?` | THE PATH OF SELFLESS SERVICE | **#1** | 4013.5 ms | ✅ PASS (Top 1) |
| **Q057** | Bhakti Yoga | `What is the difference between love and lust in spiritual devotion?` | What is the difference between love and lust, and how does it apply to Krishna's and Gopikas' sweet devotion? | **#1** | 2449.2 ms | ✅ PASS (Top 1) |
| **Q058** | Bhakti Yoga | `Should we love God more than our own family members and children?` | How can a person who wants to be attached to God deal with the family members who are attached to th | **#1** | 3802.4 ms | ✅ PASS (Top 1) |
| **Q059** | Bhakti Yoga | `What are the nine stages of devotion called Navavidha Bhakti?` | Bhakti Yoga Prakaranam (Topic of Spiritual Devotion) | **#7** | 5896.5 ms | ⚠️ HIT (Top 10) |
| **Q060** | Bhakti Yoga | `Why does God test the intensity of devotion of His closest devotees?` | Classification of devotion to God | **#4** | 4181.4 ms | ✅ PASS (Top 5) |
| **Q061** | Karma Yoga & Sacrifice | `sacrifice of fruit of work karma phala tyaga` | Can You please give a clarified version of sacrifice of fruit of work (Karma Phala Tyaga)? | **#1** | 5878.8 ms | ✅ PASS (Top 1) |
| **Q062** | Karma Yoga & Sacrifice | `What is the difference between Karma Samnyasa and Karma Phala Tyaga?` | Can the surrender of the body to God be considered as total Karma Phala Tyaga? | **#1** | 2515.2 ms | ✅ PASS (Top 1) |
| **Q063** | Karma Yoga & Sacrifice | `Why does Swami emphasize the sacrifice of hard-earned money over words and mind?` | Sacrifice of Wealth Earned By Hard Work Higher Than Sacrifice of Wealth of Forefathers | **#1** | 6724.7 ms | ✅ PASS (Top 1) |
| **Q064** | Karma Yoga & Sacrifice | `What is the true meaning of Guru Dakshina in the spiritual path?` | MEANING OF GURU DAKSHINA | **#1** | 2851.1 ms | ✅ PASS (Top 1) |
| **Q065** | Karma Yoga & Sacrifice | `Should donations be given indiscriminately to beggars on the street?` | Can food be donated indiscriminately? | **#1** | 2885.2 ms | ✅ PASS (Top 1) |
| **Q066** | Karma Yoga & Sacrifice | `Who is the eligible vessel or Satpatra for offering spiritual donation?` | Deservingness of The Recipient of Donation | **#1** | 2371.5 ms | ✅ PASS (Top 1) |
| **Q067** | Karma Yoga & Sacrifice | `Can a poor person who has no wealth practice Karma Yoga?` | How can a person do karma yoga? | **#1** | 4890.2 ms | ✅ PASS (Top 1) |
| **Q068** | Karma Yoga & Sacrifice | `Why do scriptures say that charity without discrimination leads to sin?` | Does charity wipe out sins? | **#1** | 1891.2 ms | ✅ PASS (Top 1) |
| **Q069** | Karma Yoga & Sacrifice | `What percentage of income should an ordinary householder sacrifice to God?` | God is Pleased by Practical Sacrifice | **#2** | 6108.0 ms | ✅ PASS (Top 5) |
| **Q070** | Karma Yoga & Sacrifice | `How does practical service prove the reality of theoretical devotion?` | Parabrahma Gita-9: Service of Lord Datta | **#1** | 5894.3 ms | ✅ PASS (Top 1) |
| **Q071** | Law of Karma | `Why do good people suffer in life while wicked people prosper?` | Why do some really very good people suffer? | **#1** | 4223.5 ms | ✅ PASS (Top 1) |
| **Q072** | Law of Karma | `Can astrological remedies and gemstone rings cancel our past sins?` | Relation Between Astrology And Vaastu | **#1** | 1741.6 ms | ✅ PASS (Top 1) |
| **Q073** | Law of Karma | `Is there any scriptural authority for the cancellation of sins?` | Scriptural Authority for the Cancellation of Sins | **#1** | 3374.4 ms | ✅ PASS (Top 1) |
| **Q074** | Law of Karma | `What happens to the soul immediately after death?` | What is the journey of a soul after an untimely death? | **#1** | 5177.3 ms | ✅ PASS (Top 1) |
| **Q075** | Law of Karma | `Why is human rebirth said to be extremely rare in the creation?` | Will an atheistic innovator be granted human rebirth? If not, how will his desire to innovate be ful | **#1** | 2353.3 ms | ✅ PASS (Top 1) |
| **Q076** | Law of Karma | `Does God transfer the suffering of a devotee onto His own human body?` | GOD ENTERS HUMAN BODY | **#5** | 4071.4 ms | ✅ PASS (Top 5) |
| **Q077** | Law of Karma | `Why did God create hell and painful punishments for souls?` | Liberated Souls Form God's Family | **#6** | 6039.2 ms | ⚠️ HIT (Top 10) |
| **Q078** | Law of Karma | `What is the role of prarabdha karma vs sanchita karma vs agami karma?` | Sanchita, prarabdha and agami forms of karma | **#1** | 1573.9 ms | ✅ PASS (Top 1) |
| **Q079** | Law of Karma | `Can a person escape the law of karma by taking holy dips in sacred rivers?` | How can a person do karma yoga? | **#30** | 3634.7 ms | ⚠️ HIT (Top 35) |
| **Q080** | Law of Karma | `Why do innocent children sometimes suffer with terminal illnesses?` | Is God 'jealous'? Does He make the innocent children of disobedient people suffer? | **#1** | 1476.0 ms | ✅ PASS (Top 1) |
| **Q081** | Universal Religion | `What is the central concept of the Universal Religion of Shri Datta Swami?` | Speeches of Shri Datta Swami In First World Parliament On Spirituality Part-1 | **#1** | 4507.9 ms | ✅ PASS (Top 1) |
| **Q082** | Universal Religion | `Do Hinduism and Christianity agree on the concept of Human Incarnation?` | Do Hinduism and Christianity agree on the human incarnation and getting direction from God? | **#1** | 3980.1 ms | ✅ PASS (Top 1) |
| **Q083** | Universal Religion | `Why do religious fanatics claim that only their religion leads to salvation?` | Religious Intolerance In Media | **#1** | 3562.3 ms | ✅ PASS (Top 1) |
| **Q084** | Universal Religion | `How does the message of Prophet Muhammad harmonize with the Gita and Bible?` | Is Prophet Mohammad mentioned in the Vedas? | **#1** | 3412.9 ms | ✅ PASS (Top 1) |
| **Q085** | Universal Religion | `Why did Jesus say that I and my Father are one and the Father is greater than I?` | Why does Islam say that Allah is not the Father and that Jesus is not His son? | **#1** | 4507.0 ms | ✅ PASS (Top 1) |
| **Q086** | Universal Religion | `Is conversion from one religion to another religion necessary to reach God?` | How does the conversion of a person from one religion to another become a sin? | **#1** | 4421.1 ms | ✅ PASS (Top 1) |
| **Q087** | Universal Religion | `Why did God give scriptures in different languages and cultures across the world?` | Why do You quote from scriptures when You are the human incarnation of God? | **#1** | 5330.9 ms | ✅ PASS (Top 1) |
| **Q088** | Universal Religion | `How does Lord Buddha fit into the ten avatars of Lord Vishnu?` | Who is the 9th avatar of Lord Vishnu? | **#1** | 3222.7 ms | ✅ PASS (Top 1) |
| **Q089** | Universal Religion | `What is the meaning of the Holy Spirit in Christian theology?` | Will Jesus become angry with me if I say that Jesus could not protect Himself from Christian Popes? | **#1** | 1739.4 ms | ✅ PASS (Top 1) |
| **Q090** | Universal Religion | `Can a person follow universal spirituality without leaving their birth religion?` | UNIVERSAL SPIRITUALITY FOR WORLD PEACE - OVERVIEW | **#1** | 4044.0 ms | ✅ PASS (Top 1) |
| **Q091** | Ethics & Society | `What is the true basis of the caste system according to the Bhagavad Gita?` | What is the basis for caste system in India? | **#1** | 4478.1 ms | ✅ PASS (Top 1) |
| **Q092** | Ethics & Society | `Why does Swami strongly condemn the killing of animals and eating non-vegetarian food?` | Do we incur sin by purchasing non-vegetarian food to feed dogs? | **#1** | 4248.1 ms | ✅ PASS (Top 1) |
| **Q093** | Ethics & Society | `Why does India suffer with poverty despite having rich spiritual knowledge?` | WHY DOES INDIA SUFFER WITH POVERTY? | **#1** | 1684.3 ms | ✅ PASS (Top 1) |
| **Q094** | Ethics & Society | `Are women spiritually equal to men according to the true Vedic scriptures?` | Shri RaadhaaKrishna Gita: Chapter-15: The Association of Enquiry of Equality Between Men and Women | **#1** | 2009.0 ms | ✅ PASS (Top 1) |
| **Q095** | Ethics & Society | `What spiritual advice is given to a person suffering under worldly depression?` | What advice shall be given to a person under worldly depression? | **#1** | 2945.8 ms | ✅ PASS (Top 1) |
| **Q096** | Ethics & Society | `Does a person incur sin by purchasing non-vegetarian food for family members?` | Do we incur sin by purchasing non-vegetarian food to feed dogs? | **#1** | 2953.1 ms | ✅ PASS (Top 1) |
| **Q097** | Ethics & Society | `What is the role of science and technology in the spiritual evolution of humanity?` | What is the role of science in spirituality? | **#1** | 1133.0 ms | ✅ PASS (Top 1) |
| **Q098** | Ethics & Society | `How to control the wavering mind during meditation and prayer?` | Why does the mind waver violently with worldly thoughts and desires? Why does it refuse to calm down in meditation? | **#1** | 3596.3 ms | ✅ PASS (Top 1) |
| **Q099** | Ethics & Society | `What is the spiritual solution for overcoming fear of death and illness?` | Grace During Father's Illness and Death | **#1** | 4767.1 ms | ✅ PASS (Top 1) |
| **Q100** | Ethics & Society | `Why is sacrifice of ego the most difficult of all sacrifices in spirituality?` | In pravritti life, how far a soul should sacrifice to not get ego? | **#1** | 5189.4 ms | ✅ PASS (Top 1) |
