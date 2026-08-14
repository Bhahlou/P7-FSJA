#!/usr/bin/env node
// Calcule des KPI opérationnels complémentaires aux métriques DORA :
// temps de build, temps de tests (CI), qualité SonarQube. Les indexe dans
// Elasticsearch pour visualisation dans Kibana.
//
// La fréquence des erreurs applicatives n'est pas dupliquée ici : elle est
// déjà dans l'index microcrm-back-* (stack ELK existante), le dashboard la
// lit directement depuis cette source plutôt que de la recopier.
//
// Prérequis : `gh` authentifié + stack ELK locale démarrée.
//
// Usage : node misc/kpis/collect-operational-kpis.js

const { execFileSync } = require("node:child_process");

const REPO = "Bhahlou/P7-FSJA";
const ES_URL = process.env.ES_URL || "http://localhost:9200";
const INDEX = "operational-kpis";
const SONAR_PROJECT = "Bhahlou_P7-FSJA";

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

function stepDurationSeconds(steps, name) {
  const step = steps?.find((s) => s.name === name && s.conclusion === "success");
  if (!step) return null;
  return (new Date(step.completedAt) - new Date(step.startedAt)) / 1000;
}

async function collectCiTimings() {
  console.log("Récupération des temps CI (build/test back+front)...");
  const runs = ghJson([
    "run", "list", "--repo", REPO, "--workflow=ci.yml", "--limit", "30",
    "--json", "databaseId,status,conclusion",
  ]).filter((r) => r.status === "completed" && r.conclusion === "success");

  let indexed = 0;
  for (const run of runs) {
    const detail = ghJson(["run", "view", String(run.databaseId), "--repo", REPO, "--json", "jobs"]);
    for (const job of detail.jobs) {
      let component, testStep, buildStep;
      if (job.name === "Build & test backend") {
        component = "backend";
        testStep = "Run tests";
        buildStep = "Build";
      } else if (job.name === "Build & test frontend") {
        component = "frontend";
        testStep = "Run tests";
        buildStep = "Build production bundle";
      } else {
        continue;
      }

      const testSeconds = stepDurationSeconds(job.steps, testStep);
      const buildSeconds = stepDurationSeconds(job.steps, buildStep);
      const startedAt = job.startedAt;

      if (testSeconds !== null) {
        await indexDoc(`ci-${run.databaseId}-${component}-test`, {
          metric: "ci_duration",
          component,
          step: "test",
          run_id: run.databaseId,
          duration_seconds: Math.round(testSeconds * 10) / 10,
          "@timestamp": startedAt,
        });
        indexed++;
      }
      if (buildSeconds !== null) {
        await indexDoc(`ci-${run.databaseId}-${component}-build`, {
          metric: "ci_duration",
          component,
          step: "build",
          run_id: run.databaseId,
          duration_seconds: Math.round(buildSeconds * 10) / 10,
          "@timestamp": startedAt,
        });
        indexed++;
      }
    }
  }
  console.log(`  ${indexed} mesures de durée indexées (sur ${runs.length} runs CI examinés).`);
  console.log(
    `  Note : le split test/build du backend est nouveau (ci.yml modifié) — seuls les runs postérieurs à ce changement l'auront.`
  );
}

async function collectSonarQuality() {
  console.log("Récupération de la qualité SonarCloud...");
  const res = await fetch(
    `https://sonarcloud.io/api/measures/component?component=${SONAR_PROJECT}&metricKeys=bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,sqale_index`
  );
  if (!res.ok) throw new Error(`SonarCloud API: ${res.status}`);
  const body = await res.json();
  const m = Object.fromEntries(body.component.measures.map((x) => [x.metric, Number(x.value)]));

  const analyses = await (
    await fetch(`https://sonarcloud.io/api/project_analyses/search?project=${SONAR_PROJECT}&ps=1`)
  ).json();
  const lastAnalysisDate = analyses.analyses?.[0]?.date || null;
  const timestamp = new Date().toISOString();

  // Une métrique par document (format long) plutôt qu'un seul document large :
  // permet un tableau Kibana "une ligne par métrique" lisible, et on ignore
  // simplement les métriques que SonarCloud ne renvoie pas (ex: coverage,
  // jamais calculée sur le scan de 'main', périmé — cf limitation connue)
  // plutôt que d'indexer une valeur null qui casserait le panneau.
  const rows = [
    { key: "bugs", label: "Bugs", value: m.bugs },
    { key: "vulnerabilities", label: "Vulnérabilités", value: m.vulnerabilities },
    { key: "code_smells", label: "Code smells", value: m.code_smells },
    { key: "coverage", label: "Couverture (%)", value: m.coverage },
    { key: "duplicated_lines", label: "Duplication (%)", value: m.duplicated_lines_density },
    { key: "tech_debt", label: "Dette technique (min)", value: m.sqale_index },
  ];

  for (const row of rows) {
    if (row.value === undefined || Number.isNaN(row.value)) {
      console.log(`  ${row.label} : non disponible sur SonarCloud, ignoré.`);
      continue;
    }
    await indexDoc(`sonar-quality-${row.key}`, {
      metric: "sonar_quality",
      metric_label: row.label,
      metric_value: row.value,
      last_analysis_date: lastAnalysisDate,
      "@timestamp": timestamp,
    });
  }
  console.log(
    `  bugs=${m.bugs} vulnerabilities=${m.vulnerabilities} code_smells=${m.code_smells} dette=${m.sqale_index}min`
  );
  if (lastAnalysisDate) {
    const ageDays = (Date.now() - new Date(lastAnalysisDate)) / 86400000;
    console.log(
      `  Dernière analyse sur 'main' : ${lastAnalysisDate} (${ageDays.toFixed(1)} jours) — limitation connue, sonar ne tourne que sur pull_request.`
    );
  }
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

  await collectCiTimings();
  await collectSonarQuality();

  console.log(`\nDonnées indexées dans ${ES_URL}/${INDEX}. Dashboard Kibana : "KPI Opérationnels".`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
