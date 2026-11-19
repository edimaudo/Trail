export async function loadRuntimeConfig() {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok)
        throw new Error('Trail could not load its public application configuration from FastAPI.');
    const config = await response.json();
    window.TRAIL_CONFIG = config;
    return config;
}
