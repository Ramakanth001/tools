# Standard Search Sealed Release Verdict

**Execution Date:** 2026-11-18T06:24:36.144Z  
**Split:** `holdout` (Fresh Unseen Holdout: 30 reviewed cases: 10 positive paraphrases, 20 negative controls)  
**Benchmark Version:** 2  
**Git Commit SHA:** `fb46fbee2ab395f277a142d3cf2b55a6aba06662`  
**Git Working Tree:** clean  
**Target Database:** `universal_qa_v3_candidate` (port 5433, 6010 records)  
**Corpus Contract:** Schema `answer-unit-v7`, Embedding `generic-contextual-v4`, Model `bge-m3`  
**Benchmark File Hash (SHA-256):** `496fbc3a976a7c1bd52e19215f02567bc7a8abcf0f5446c4613d2e75c5ec58e9`  
**Evaluation Duration:** 28.5s  

---

## 1. Release Gates Scorecard (Sealed Holdout)

| Gate | Target Requirement | Measured Value | Result |
| :--- | :--- | :--- | :--- |
| **1. Positive Admission Rate** | $\ge 0.95$ ($\ge 95\%$ strong-match pass) | **100.0%** (10/10) | PASSED |
| **2. Positive Recall@5** | $\ge 0.95$ ($\ge 95\%$ in top-5) | **100.0%** (10/10) | PASSED |
| **3. Positive Top-1 Accuracy** | $\ge 0.90$ ($\ge 90\%$ rank 1) | **100.0%** (10/10) | PASSED |
| **4. Negative False-Accept Rate** | $\le 0.02$ ($\le 2\%$ false accepts) | **0.0%** (0/20) | PASSED |

---

## 2. Verdict & Recommendation

**Verdict:** **APPROVED**  
Standard Search satisfies all four release gates on the sealed test set. The model cleanly admits answerable spiritual paraphrases while strictly abstaining from physical tasks, out-of-domain knowledge, and lexical traps.

---

## 3. Category Breakdown

| Category | Total Cases | Passed | False Accepts | Top-1 Hits |
| :--- | :--- | :--- | :--- | :--- |
| `positive_paraphrase` | 10 | 10 (100.0%) | 0 | 10 |
| `lexical_trap` | 5 | 5 (100.0%) | 0 | 0 |
| `physical_and_recipes` | 5 | 5 (100.0%) | 0 | 0 |
| `general_knowledge` | 4 | 4 (100.0%) | 0 | 0 |
| `unanswered_spiritual` | 3 | 3 (100.0%) | 0 | 0 |
| `noisy_and_transliterated` | 3 | 3 (100.0%) | 0 | 0 |

---

## 4. Failure Ledger

No failures on the sealed test set (100% pass rate).
