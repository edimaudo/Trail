import { getApps, initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider, getToken } from 'firebase/app-check';
import { AgentPlatformBackend, getAI } from 'firebase/ai';
let firebaseApp;
let aiService;
let appCheckService;
let appCheckError;
let initialized = false;
export function initializeFirebase(config) {
    if (initialized)
        return;
    initialized = true;
    const values = config.firebase;
    if (!config.firebaseConfigured || !values.apiKey || !values.projectId || !values.appId) {
        appCheckError = 'Firebase is not configured. Add the public Firebase Web configuration to the FastAPI environment.';
        return;
    }
    firebaseApp = getApps().length ? getApps()[0] : initializeApp(values);
    if (config.appCheckSiteKey) {
        try {
            appCheckService = initializeAppCheck(firebaseApp, {
                provider: new ReCaptchaV3Provider(config.appCheckSiteKey),
                isTokenAutoRefreshEnabled: true,
            });
        }
        catch (error) {
            appCheckError = error instanceof Error ? error.message : 'Firebase App Check initialization failed.';
        }
    }
    else if (config.appCheckEnforced) {
        appCheckError = 'FastAPI requires App Check, but FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY is not configured.';
    }
    aiService = getAI(firebaseApp, { backend: new AgentPlatformBackend(config.aiLocation || 'global') });
}
export function getAIService() {
    if (!aiService)
        throw new Error('Firebase AI Logic is not initialized. Check the Firebase environment configuration.');
    if (appCheckError && window.TRAIL_CONFIG?.appCheckEnforced)
        throw new Error(appCheckError);
    return aiService;
}
export function getAppCheckIssue() {
    return appCheckError;
}
export async function getAppCheckToken() {
    if (!appCheckService)
        return undefined;
    const result = await getToken(appCheckService, false);
    return result.token;
}
