# Standard Search Sealed Release Verdict

**Execution Date:** 2026-11-18T03:46:55.776Z  
**Split:** `test_sealed` (30 reviewed cases: 10 positive paraphrases, 20 negative controls)  
**Git Commit SHA:** `085b1c28404efb5d7f6f971e5403b3da29053ad1`  
**Git Working Tree:** dirty (uncommitted working tree changes)  
**Target Database:** `universal_qa_v3_candidate` (port 5433, 6010 records)  
**Corpus Contract:** Schema `answer-unit-v7`, Embedding `generic-contextual-v4`, Model `bge-m3`  
**Benchmark File Hash (SHA-256):** `9fb90b34b32df3db3084ff9b4a3c9c53788becd0e5e32d9b72517adb8b5e6204`  
**Evaluation Duration:** 71.7s  

---

## 1. Release Gates Scorecard (Sealed Holdout)

| Gate | Target Requirement | Measured Value | Result |
| :--- | :--- | :--- | :--- |
| **1. Positive Admission Rate** | $\ge 0.95$ ($\ge 95\%$ strong-match pass) | **90.0%** (9/10) | **FAILED** |
| **2. Positive Recall@5** | $\ge 0.95$ ($\ge 95\%$ in top-5) | **90.0%** (9/10) | **FAILED** |
| **3. Positive Top-1 Accuracy** | $\ge 0.90$ ($\ge 90\%$ rank 1) | **70.0%** (7/10) | **FAILED** |
| **4. Negative False-Accept Rate** | $\le 0.02$ ($\le 2\%$ false accepts) | **0.0%** (0/20) | PASSED |

---

## 2. Verdict & Recommendation

**Verdict:** **REJECTED**  
Standard Search did not meet one or more release gates on the sealed test set. Production promotion must be withheld until all four gates pass.

---

## 3. Category Breakdown

| Category | Total Cases | Passed | False Accepts | Top-1 Hits |
| :--- | :--- | :--- | :--- | :--- |
| `positive_paraphrase` | 10 | 9 (90.0%) | 0 | 7 |
| `lexical_trap` | 5 | 5 (100.0%) | 0 | 0 |
| `physical_and_recipes` | 5 | 5 (100.0%) | 0 | 0 |
| `general_knowledge` | 4 | 4 (100.0%) | 0 | 0 |
| `unanswered_spiritual` | 3 | 3 (100.0%) | 0 | 0 |
| `noisy_and_transliterated` | 3 | 3 (100.0%) | 0 | 0 |

---

## 4. Failure Ledger

### Failure 1: `pos-46`
* **Question:** "Why do pure souls sometimes suffer intense physical illness and pain on earth?"
* **Category:** `positive_paraphrase` (shouldAbstain: false)
* **Expected:** Strong Match for `discourse:4193`
* **Actual:** `strongMatch = true` (accepted: `qa:78`, rank: null)

