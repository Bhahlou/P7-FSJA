#!/usr/bin/env node
// Calcule les métriques DORA (lead time, deploiement) depuis GitHub Actions
// et les indexe dans Elasticsearch pour visualisation dans Kibana.
// Le MTTR n'est volontairement pas automatisé : il nécessite une
// qualification humaine de ce qu'est un "incident", pas déductible
// des seules données GitHub Actions. Il reste documenté manuellement.
//
// Prérequis : `gh` authentifié (gh auth status) + stack ELK locale démarrée
// (docker compose -f docker-compose-elk.yml up -d).
//
// Usage : node misc/dora/collect-dora-metrics.js

const { execFileSync } = require("node:child_process");

const REPO = "Bhahlou/P7-FSJA";
const ES_URL = process.env.ES_URL || "http://localhost:9200";
const INDEX = "dora-metrics";

function ghJson(args) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(out);
}

async function indexDoc(id, doc) {
  const res = await fetch(`${ES_URL}/${INDEX}/_doc/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  if (!res.ok) {
    throw new Error(`Échec indexation ${id}: ${res.status} ${await res.text()}`);
  }
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  console.log(`Vérification d'Elasticsearch (${ES_URL})...`);
  const ping = await fetch(`${ES_URL}`).catch(() => null);
  if (!ping?.ok) {
    throw new Error(
      `Elasticsearch injoignable sur ${ES_URL}. Démarre la stack ELK : ` +
        `docker compose -f docker-compose-elk.yml up -d`
    );
  }

  console.log("Récupération des PR mergées (Lead Time)...");
  const prs = ghJson([
    "pr", "list", "--repo", REPO, "--state", "merged", "--limit", "100",
    "--json", "number,title,createdAt,mergedAt",
  ]);

  const leadTimes = [];
  for (const pr of prs) {
    const leadMinutes =
      (new Date(pr.mergedAt).getTime() - new Date(pr.createdAt).getTime()) / 60000;
    leadTimes.push(leadMinutes);
    await indexDoc(`pr-${pr.number}`, {
      metric: "lead_time",
      pr_number: pr.number,
      title: pr.title,
      created_at: pr.createdAt,
      merged_at: pr.mergedAt,
      lead_time_minutes: Math.round(leadMinutes * 10) / 10,
      "@timestamp": pr.mergedAt,
    });
  }
  console.log(`  ${prs.length} PR indexées.`);

  console.log("Récupération des runs cd.yml (Deployment Frequency / Change Failure Rate)...");
  const runs = ghJson([
    "run", "list", "--repo", REPO, "--workflow=cd.yml", "--limit", "100",
    "--json", "databaseId,conclusion,status,createdAt,updatedAt",
  ]).filter((r) => r.status === "completed");

  let successCount = 0;
  let failureCount = 0;
  for (const run of runs) {
    if (run.conclusion === "success") successCount++;
    else if (run.conclusion === "failure") failureCount++;
    await indexDoc(`run-${run.databaseId}`, {
      metric: "deployment",
      run_id: run.databaseId,
      conclusion: run.conclusion,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      "@timestamp": run.createdAt,
    });
  }
  console.log(`  ${runs.length} runs indexés.`);

  const leadTimeMedian = median(leadTimes);
  const total = successCount + failureCount;
  const cfr = total > 0 ? (failureCount / total) * 100 : null;

  console.log("\n=== Résumé ===");
  console.log(`Lead Time — médiane: ${leadTimeMedian?.toFixed(1)} min (n=${leadTimes.length})`);
  console.log(`Deployment Frequency — ${successCount} déploiements réussis`);
  console.log(`Change Failure Rate (pipeline) — ${failureCount}/${total} = ${cfr?.toFixed(1)}%`);
  console.log(
    `MTTR — non calculé automatiquement (voir doc, section 6.2 : nécessite une qualification humaine de l'incident).`
  );

  // Résumé pré-calculé, pour affichage direct dans Kibana sans recalcul côté Lens
  // (les agrégations mixtes médiane/compte/ratio sur des sous-ensembles filtrés
  // différents sont fragiles à exprimer en Lens Formula).
  await indexDoc("summary", {
    metric: "summary",
    lead_time_median_minutes: leadTimeMedian !== null ? Math.round(leadTimeMedian * 10) / 10 : null,
    deployment_success_count: successCount,
    deployment_failure_count: failureCount,
    deployment_total_count: total,
    change_failure_rate_percent: cfr !== null ? Math.round(cfr * 10) / 10 : null,
    "@timestamp": new Date().toISOString(),
  });

  console.log(`\nDonnées indexées dans ${ES_URL}/${INDEX}. Dashboard Kibana : "DORA Metrics".`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
