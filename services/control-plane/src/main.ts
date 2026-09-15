import { Pool } from "pg";
import { ActiveAccountSessionVerifier,OidcSessionVerifier,ProvisioningAccountSessionVerifier } from "./auth.js";
import { HttpTransactionalEmail } from "./email.js";
import { HttpImmutablePackageStorage, HttpPackageReviewScanner } from "./package_services.js";
import { UnavailablePackageScanner,UnavailablePackageStorage,UnavailableTransactionalEmail } from "./beta_adapters.js";
import { PostgresRepository } from "./postgres.js";
import { createServer } from "./server.js";
import { Ed25519RunnerCommandSigner } from "./runner_protocol.js";
import { StripeBillingProvider } from "./billing.js";
import { Ed25519EntitlementClaimSigner } from "./entitlement.js";
import { WebhookProtector } from "./webhook_crypto.js";
import { CompositeSessionVerifier, PostgresCredentialService } from "./credentials.js";
import { PostgresApiIdempotencyStore } from "./api_contract.js";
import { PostgresUsageLedger } from "./usage.js";
import { HmacUsageProducerAuthenticator,parseUsageProducerSecrets } from "./usage_producer.js";
import { PostgresCredentialExpiryNotifier } from "./credential_notifications.js";
import { PostgresServiceAccountAccessReviews } from "./access_reviews.js";
import { ReadinessService, RecurringTaskMonitor, ServiceMetrics } from "./reliability.js";
import { PostgresSupportAccess } from "./support_access.js";
import { PostgresPrivacyService } from "./privacy.js";
import { PostgresProductCommerce } from "./product_commerce.js";
import { PostgresExecutionCoordinator } from "./execution_coordinator.js";
import { DiscordBugReportSink } from "./bug_reports.js";
import { PostgresPrepaidBilling } from "./prepaid.js";
import { PostgresReferralProgram } from "./referrals.js";
import { PostgresCollaborationService } from "./collaboration.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const betaMode=process.env.SANDBOX_BETA_MODE==="true";
const integration=(names:string[],label:string):string[]|null=>{
  const values=names.map(name=>process.env[name]?.trim()??"");
  if(!betaMode)return names.map(required);
  if(values.every(value=>!value))return null;
  if(values.some(value=>!value))throw new Error(`${label} must either be fully configured or omitted in beta mode.`);
  return values;
};

const pool = new Pool({
  connectionString: required("DATABASE_URL"),
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 15_000
});

const controlPlanePublicUrl=required("CONTROL_PLANE_PUBLIC_URL").replace(/\/$/,"");
const oidcSessions=new OidcSessionVerifier({ issuer: required("OIDC_ISSUER"), audience: required("OIDC_AUDIENCE"), jwksUrl: required("OIDC_JWKS_URL") });
const provisionedOidcSessions=betaMode?new ProvisioningAccountSessionVerifier(oidcSessions,pool):oidcSessions;
const credentialService=new PostgresCredentialService(pool,Buffer.from(required("ACCESS_TOKEN_PEPPER_BASE64"),"base64"),`${controlPlanePublicUrl}/v1/service-account-assertions/token`);
const webhookProtector=new WebhookProtector(Buffer.from(required("WEBHOOK_ENCRYPTION_KEY_BASE64"),"base64"));
const idempotencyProtector=new WebhookProtector(Buffer.from(required("API_IDEMPOTENCY_ENCRYPTION_KEY_BASE64"),"base64"));
const emailConfiguration=integration(["EMAIL_API_URL","EMAIL_API_KEY","EMAIL_SENDER"],"Transactional email");
const email=emailConfiguration
  ?new HttpTransactionalEmail(emailConfiguration[0],emailConfiguration[1],emailConfiguration[2])
  :new UnavailableTransactionalEmail();
const packageConfiguration=integration(["OBJECT_STORAGE_SIGNER_URL","OBJECT_STORAGE_SIGNER_TOKEN","PACKAGE_SCANNER_URL","PACKAGE_SCANNER_TOKEN"],"Package publishing");
const packageStorage=packageConfiguration
  ?new HttpImmutablePackageStorage(packageConfiguration[0],packageConfiguration[1])
  :new UnavailablePackageStorage();
const packageScanner=packageConfiguration
  ?new HttpPackageReviewScanner(packageConfiguration[2],packageConfiguration[3])
  :new UnavailablePackageScanner();
const runnerSigningConfiguration=integration(["RUNNER_COMMAND_SIGNING_KEY_ID","RUNNER_COMMAND_SIGNING_PRIVATE_KEY_PEM"],"Runner command signing");
const entitlementSigningConfiguration=integration(["ENTITLEMENT_SIGNING_KEY_ID","ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM"],"Entitlement signing");
const usageProducerConfiguration=integration(["USAGE_PRODUCER_SECRETS_JSON"],"Usage ingestion");
const bugReportConfiguration=integration(["BUG_REPORT_DISCORD_WEBHOOK_URL"],"Bug reporting");
const credentialExpiryNotifier=new PostgresCredentialExpiryNotifier(pool,email);
const accessReviews=new PostgresServiceAccountAccessReviews(pool);
const privacy=new PostgresPrivacyService(pool);
const credentialExpirySweepIntervalMs=Number(process.env.CREDENTIAL_EXPIRY_SWEEP_INTERVAL_MS??3_600_000);
if(!Number.isSafeInteger(credentialExpirySweepIntervalMs)||credentialExpirySweepIntervalMs<60_000)throw new Error("CREDENTIAL_EXPIRY_SWEEP_INTERVAL_MS must be an integer of at least 60000");
const privacyRetentionSweepIntervalMs=Number(process.env.PRIVACY_RETENTION_SWEEP_INTERVAL_MS??86_400_000);
if(!Number.isSafeInteger(privacyRetentionSweepIntervalMs)||privacyRetentionSweepIntervalMs<60_000)throw new Error("PRIVACY_RETENTION_SWEEP_INTERVAL_MS must be an integer of at least 60000");
const recurringTasks=new RecurringTaskMonitor();
const recurringTaskMaximumAgeMs=credentialExpirySweepIntervalMs*2;
const metrics=new ServiceMetrics();
const usageLedger=new PostgresUsageLedger(pool);
const referrals=new PostgresReferralProgram(pool);
const prepaidBilling=new PostgresPrepaidBilling(pool,referrals);
const readiness=new ReadinessService([
  {name:"database",check:async()=>{await pool.query("SELECT 1");}},
  recurringTasks.probe("credential-expiry-notifications",recurringTaskMaximumAgeMs),
  recurringTasks.probe("service-account-access-reviews",recurringTaskMaximumAgeMs),
  recurringTasks.probe("privacy-retention",privacyRetentionSweepIntervalMs*2)
]);

const server = await createServer({
  repository: new PostgresRepository(pool),
  sessions: new ActiveAccountSessionVerifier(new CompositeSessionVerifier(provisionedOidcSessions,credentialService),pool),
  credentialService,
  accessReviews,
  supportAccess:new PostgresSupportAccess(pool),
  privacy,
  productCommerce:new PostgresProductCommerce(pool),
  email,
  packageStorage,
  packageScanner,
  runnerCommandSigner: runnerSigningConfiguration?new Ed25519RunnerCommandSigner(runnerSigningConfiguration[0],runnerSigningConfiguration[1].replace(/\\n/g, "\n")):undefined,
  billing: new StripeBillingProvider(required("STRIPE_SECRET_KEY"), required("STRIPE_WEBHOOK_SECRET")),
  entitlementSigner: entitlementSigningConfiguration?new Ed25519EntitlementClaimSigner(entitlementSigningConfiguration[0],controlPlanePublicUrl,entitlementSigningConfiguration[1].replace(/\\n/g, "\n")):undefined,
  webhookProtector,
  idempotencyStore: new PostgresApiIdempotencyStore(pool,idempotencyProtector),
  usageLedger,
  usageReader:usageLedger,
  prepaidBilling,
  referrals,
  usageProducerAuthenticator: usageProducerConfiguration?new HmacUsageProducerAuthenticator(parseUsageProducerSecrets(usageProducerConfiguration[0])):undefined,
  executionCoordinator: new PostgresExecutionCoordinator(pool),
  bugReports: bugReportConfiguration?new DiscordBugReportSink(bugReportConfiguration[0]):undefined,
  collaboration: new PostgresCollaborationService(pool),
  readiness,
  metrics,
  metricsBearerToken:required("METRICS_BEARER_TOKEN"),
  protectedValueProtector: new WebhookProtector(Buffer.from(required("PROTECTED_VALUE_ENCRYPTION_KEY_BASE64"), "base64")),
  webhookBaseUrl: controlPlanePublicUrl,
  webBaseUrl: required("WEB_BASE_URL"),
  logger: true
});

let credentialNotificationTimer:NodeJS.Timeout|undefined,accessReviewTimer:NodeJS.Timeout|undefined,privacyRetentionTimer:NodeJS.Timeout|undefined;
const runCredentialNotifications=async()=>{try{const result=await credentialExpiryNotifier.runOnce();recurringTasks.success("credential-expiry-notifications");if(result.enqueued||result.sent||result.failed)server.log.info(result,"credential expiry notification sweep completed");}catch(error){server.log.error(error,"credential expiry notification sweep failed");}};
const runAccessReviews=async()=>{try{const result=await accessReviews.runOnce();recurringTasks.success("service-account-access-reviews");if(result.opened||result.overdue||result.revokedCredentials)server.log.info(result,"service-account access-review sweep completed");}catch(error){server.log.error(error,"service-account access-review sweep failed");}};
const runPrivacyRetention=async()=>{try{const result=await privacy.runRetentionSweep();recurringTasks.success("privacy-retention");if(result.executionDetails||result.queueEvents||result.webhookDeliveries||result.runnerCommands||result.auditEvents||result.operationalEvidence)server.log.info(result,"privacy retention sweep completed");}catch(error){server.log.error(error,"privacy retention sweep failed");}};
const shutdown = async () => {
  if(credentialNotificationTimer)clearInterval(credentialNotificationTimer);
  if(accessReviewTimer)clearInterval(accessReviewTimer);
  if(privacyRetentionTimer)clearInterval(privacyRetentionTimer);
  await server.close();
  await pool.end();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await server.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 4100) });
if(betaMode)server.log.warn("SANDBOX_BETA_MODE is enabled; new verified Auth0 identities are provisioned on first API access and unconfigured beta integrations return HTTP 503.");
void runCredentialNotifications();
void runAccessReviews();
void runPrivacyRetention();
credentialNotificationTimer=setInterval(()=>void runCredentialNotifications(),credentialExpirySweepIntervalMs);
credentialNotificationTimer.unref();
accessReviewTimer=setInterval(()=>void runAccessReviews(),credentialExpirySweepIntervalMs);
accessReviewTimer.unref();
privacyRetentionTimer=setInterval(()=>void runPrivacyRetention(),privacyRetentionSweepIntervalMs);
privacyRetentionTimer.unref();
