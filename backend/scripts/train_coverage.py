"""Train and evaluate the edge headline match model on frozen, reviewed pairs."""

import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]
FIXTURE = BACKEND / "test" / "fixtures" / "coverage-pairs.json"
MODEL = BACKEND / "src" / "coverage-model.json"
SPLITS = ("train", "validation", "test")


def probability(features, weights, bias):
    score = sum(weight * value for weight, value in zip(weights, features)) + bias
    return 1 / (1 + math.exp(-max(-35, min(35, score))))


def fit(examples, width):
    """Batch gradient descent for L2-regularized logistic regression."""
    eligible = [example for example in examples if example["features"] is not None]
    weights = [0.0] * width
    bias = 0.0
    for _ in range(1400):
        gradient = [0.0] * width
        bias_gradient = 0.0
        for example in eligible:
            features = example["features"]
            error = probability(features, weights, bias) - int(example["sameDevelopment"])
            bias_gradient += error
            for index, value in enumerate(features):
                gradient[index] += error * value
        weights = [
            weight - 0.7 * (change / len(eligible) + 0.015 * weight)
            for weight, change in zip(weights, gradient)
        ]
        bias -= 0.7 * bias_gradient / len(eligible)
    return [round(weight, 8) for weight in weights], round(bias, 8)


def metrics(examples, predictions):
    true_positive = false_positive = false_negative = true_negative = 0
    for example, predicted in zip(examples, predictions):
        actual = example["sameDevelopment"]
        if predicted and actual:
            true_positive += 1
        elif predicted:
            false_positive += 1
        elif actual:
            false_negative += 1
        else:
            true_negative += 1
    precision = true_positive / max(1, true_positive + false_positive)
    recall = true_positive / max(1, true_positive + false_negative)
    f_half = 1.25 * precision * recall / (0.25 * precision + recall) if true_positive else 0
    return {
        "pairs": len(examples),
        "tp": true_positive,
        "fp": false_positive,
        "fn": false_negative,
        "tn": true_negative,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f0_5": round(f_half, 4),
    }


def eligibility_score(example, weights, bias):
    features = example["features"]
    return probability(features, weights, bias) if features is not None else -1


def calibrate(examples, weights, bias):
    scores = [eligibility_score(example, weights, bias) for example in examples]
    thresholds = [cutoff / 100 for cutoff in range(30, 91)]

    def objective(threshold):
        result = metrics(examples, (score >= threshold for score in scores))
        # The comparison UI favors precision on validation. F0.5 also penalizes false positives.
        return result["precision"] >= 0.9, result["f0_5"], threshold

    return max(thresholds, key=objective)


def load_examples():
    raw = subprocess.run(
        ["node", str(BACKEND / "scripts" / "coverage-examples.mjs")],
        check=True, capture_output=True, encoding="utf-8",
    )
    data = json.loads(raw.stdout)
    splits = {key: [] for key in SPLITS}
    groups = {}
    article_splits = {}
    headline_splits = {}
    pairs = set()
    for example in data["examples"]:
        group = example["group"]
        split = example["split"]
        if group in groups and groups[group] != split:
            raise ValueError(f"Development group crosses splits: {group}")
        groups[group] = split
        identifiers = tuple(sorted(example[side]["id"] for side in ("left", "right")))
        if len(set(identifiers)) != 2 or identifiers in pairs:
            raise ValueError(f"Repeated or self pair: {identifiers}")
        pairs.add(identifiers)
        for identifier in identifiers:
            if identifier in article_splits and article_splits[identifier] != split:
                raise ValueError(f"Article crosses splits: {identifier}")
            article_splits[identifier] = split
        for side in ("left", "right"):
            headline = example[side]["title"].casefold().strip()
            if headline in headline_splits and headline_splits[headline] != split:
                raise ValueError(f"Repeated headline crosses splits: {headline}")
            headline_splits[headline] = split
        if not isinstance(example["sameDevelopment"], bool):
            raise ValueError(f"Invalid label: {identifiers}")
        splits[split].append(example)
    if any({row["sameDevelopment"] for row in examples} != {True, False} for examples in splits.values()):
        raise ValueError("Every split needs positive and negative pairs")
    return data["features"], splits


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-model", action="store_true", help="Publish the trained artifact to the Worker source tree")
    args = parser.parse_args()
    names, splits = load_examples()
    weights, bias = fit(splits["train"], len(names))
    threshold = calibrate(splits["validation"], weights, bias)
    artifact = {
        "version": 1,
        "fixtureSha256": hashlib.sha256(FIXTURE.read_bytes().replace(b"\r\n", b"\n")).hexdigest(),
        "threshold": threshold,
        "bias": bias,
        "weights": dict(zip(names, weights)),
    }
    report = {}
    for split, examples in splits.items():
        predictions = (eligibility_score(example, weights, bias) >= threshold for example in examples)
        report[split] = {
            "baseline": metrics(examples, (example["baseline"] for example in examples)),
            "learned": metrics(examples, predictions),
        }
    print(json.dumps({"threshold": threshold, "results": report}, indent=2))
    # Guard the comparison across both types of error on the same fixture.
    test = report["test"]
    if test["learned"]["f0_5"] < test["baseline"]["f0_5"]:
        raise SystemExit("Held-out headline matching regressed")
    if args.write_model:
        MODEL.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    elif json.loads(MODEL.read_text(encoding="utf-8")) != artifact:
        raise SystemExit("The saved coverage model differs from the reproducible result")


if __name__ == "__main__":
    main()
