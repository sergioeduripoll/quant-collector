import 'dotenv/config';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import express from 'express'; 

// --- CONFIGURACIÓN DE SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- CONFIGURACIÓN DE ACTIVOS ---
const ASSETS = [
    'BTC-USDT', 'ETH-USDT', 'ADA-USDT', 'LTC-USDT',
    'SOL-USDT', 'XRP-USDT', 'DOGE-USDT', 'BNB-USDT'
];

const INTERVAL = '5min'; 
const TARGET_CANDLES = 50000;

// --- SERVIDOR DE "LATIDO" (Para que Render no lo apague) ---
const app = express();
app.get('/', (req, res) => res.send('🚀 QUANT SNIPER COLLECTOR - ACTIVO Y OPERANDO'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[CLOUD] Servidor de latido en puerto ${PORT}`));

async function syncCandlesForAsset(kucoinSymbol) {
    const dbSymbol = kucoinSymbol.replace('-', '');
    
    try {
        // 1. Contamos cuántas velas tenemos realmente
        const { count, error: countError } = await supabase
            .from('candles')
            .select('*', { count: 'exact', head: true })
            .eq('symbol', dbSymbol)
            .eq('interval', '5m');

        if (countError) throw countError;

        if (count < 49000) {
            // ==============================================
            // MODO TURBO: PAGINACIÓN HACIA ATRÁS (REVERSE)
            // ==============================================
            console.log(`   [!] ${dbSymbol} tiene solo ${count || 0} velas en DB. Iniciando MODO TURBO (Hacia el pasado)...`);
            
            let currentEndAt = Math.floor(Date.now() / 1000); // Empezamos AHORA MISMO
            let totalSavedInThisSession = 0;
            let keepFetching = true;
            let retries = 0;
            let targetToFetch = TARGET_CANDLES - (count || 0);

            while (keepFetching && totalSavedInThisSession < targetToFetch) {
                // Pedimos a KuCoin que nos dé todo lo que haya ANTES de 'currentEndAt'
                const url = `https://api.kucoin.com/api/v1/market/candles?type=${INTERVAL}&symbol=${kucoinSymbol}&endAt=${currentEndAt}`;
                
                let res;
                try {
                    res = await axios.get(url, { timeout: 15000 });
                    retries = 0; 
                } catch (axiosError) {
                    console.log(`\n   [!] Reintentando ${dbSymbol}... (Motivo: ${axiosError.message})`);
                    retries++;
                    if (retries >= 3) {
                        console.error(`   [X] Abortando descarga de ${dbSymbol} tras 3 fallos.`);
                        break; 
                    }
                    await new Promise(r => setTimeout(r, 2000)); 
                    continue;
                }
                
                if (!res || !res.data || !res.data.data || res.data.data.length === 0) {
                    console.log(`\n   [?] Se alcanzó el origen de los tiempos para ${dbSymbol}. Fin de la historia.`);
                    break;
                }

                // KuCoin entrega desde lo más nuevo a lo más viejo
                const klines = res.data.data; 

                const rows = klines.map(c => ({
                    symbol: dbSymbol, 
                    interval: '5m',   
                    timestamp: parseInt(c[0]) * 1000, 
                    open: parseFloat(c[1]),
                    high: parseFloat(c[3]), 
                    low: parseFloat(c[4]),  
                    close: parseFloat(c[2]),
                    volume: parseFloat(c[5])
                }));

                const { error } = await supabase.from('candles').upsert(rows, { 
                    onConflict: 'symbol, interval, timestamp', 
                    ignoreDuplicates: true 
                });
                
                if (error) throw error;

                totalSavedInThisSession += rows.length;
                
                // LA MAGIA DE IR HACIA ATRÁS:
                // Tomamos el timestamp de la vela más vieja que nos dio (la última del array) y le restamos 1 segundo.
                // En el siguiente ciclo, pedirá desde ese momento hacia el pasado.
                currentEndAt = parseInt(klines[klines.length - 1][0]) - 1;
                
                process.stdout.write(`\r   [*] ${dbSymbol} Progreso: ${totalSavedInThisSession} velas históricas succionadas...`);
                
                if (klines.length < 10) keepFetching = false;
                
                await new Promise(r => setTimeout(r, 1000)); // Respiro para la API
            }
            console.log(`\n   [OK] ${dbSymbol} MODO TURBO Finalizado (+${totalSavedInThisSession} velas).`);
            
        } else {
            // ==============================================
            // MODO MANTENIMIENTO (Vuelo Crucero)
            // ==============================================
            // Simplemente bajamos el paquete más reciente y actualizamos. Supabase ignora las repetidas.
            const url = `https://api.kucoin.com/api/v1/market/candles?type=${INTERVAL}&symbol=${kucoinSymbol}`;
            let res;
            try {
                res = await axios.get(url, { timeout: 15000 });
            } catch (e) {
                console.log(`   [!] Fallo mantenimiento ${dbSymbol}. Se intentará en 5 min.`);
                return;
            }

            if (res && res.data && res.data.data) {
                const klines = res.data.data;
                const rows = klines.map(c => ({
                    symbol: dbSymbol, 
                    interval: '5m',   
                    timestamp: parseInt(c[0]) * 1000, 
                    open: parseFloat(c[1]),
                    high: parseFloat(c[3]), 
                    low: parseFloat(c[4]),  
                    close: parseFloat(c[2]),
                    volume: parseFloat(c[5])
                }));

                const { error } = await supabase.from('candles').upsert(rows, { 
                    onConflict: 'symbol, interval, timestamp', 
                    ignoreDuplicates: true 
                });
                
                if (error) throw error;
                console.log(`   [OK] ${dbSymbol} sincronizado (Mantenimiento al día).`);
            }
        }
    } catch (error) {
        console.error(`   [X] Error fatal en ${dbSymbol}:`, error.message);
    }
}

async function runCollector() {
    console.log("\n=========================================");
    console.log("   QUANT SNIPER - CLOUD ENGINE V12.5");
    console.log(`   ${new Date().toLocaleString()}`);
    console.log("=========================================");

    for (const asset of ASSETS) {
        await syncCandlesForAsset(asset);
    }

    console.log("\n✅ CICLO COMPLETADO. Esperando 5 min...");
    setTimeout(runCollector, 5 * 60 * 1000);
}

// Arrancar el motor
runCollector();
