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
        const { data: lastCandle, error: dbError } = await supabase
            .from('candles')
            .select('timestamp')
            .eq('symbol', dbSymbol)
            .eq('interval', '5m') 
            .order('timestamp', { ascending: false })
            .limit(1);

        if (dbError) throw dbError;

        const { count, error: countError } = await supabase
            .from('candles')
            .select('*', { count: 'exact', head: true })
            .eq('symbol', dbSymbol)
            .eq('interval', '5m');

        let startTime;
        let isDeepFetch = false; // Bandera para saber si estamos en modo "Sanación"
        
        if (count < 49000) {
            console.log(`   [!] ${dbSymbol} tiene solo ${count || 0} velas en DB. Iniciando MODO TURBO para llegar a 50k...`);
            // Calculamos la fecha de hace 50.000 velas atrás
            startTime = Math.floor(Date.now() / 1000) - (TARGET_CANDLES * 5 * 60); 
            isDeepFetch = true;
        } else if (lastCandle && lastCandle.length > 0) {
            startTime = Math.floor(lastCandle[0].timestamp / 1000); 
        } else {
            startTime = Math.floor(Date.now() / 1000) - (TARGET_CANDLES * 5 * 60);
            isDeepFetch = true;
        }

        let totalSavedInThisSession = 0;
        let keepFetching = true;
        let retries = 0;

        while (keepFetching) {
            // Bloques de 1500 velas (el máximo de KuCoin)
            const endAt = startTime + (1500 * 5 * 60); 
            const url = `https://api.kucoin.com/api/v1/market/candles?type=${INTERVAL}&symbol=${kucoinSymbol}&startAt=${startTime + 1}&endAt=${endAt}`;
            
            let res;
            try {
                res = await axios.get(url, { timeout: 15000 });
                retries = 0; 
            } catch (axiosError) {
                console.log(`   [!] Reintentando ${dbSymbol}... (Motivo: ${axiosError.message})`);
                retries++;
                if (retries >= 3) {
                    console.error(`   [X] Abortando descarga de ${dbSymbol} tras 3 fallos.`);
                    break; 
                }
                await new Promise(r => setTimeout(r, 2000)); 
                continue;
            }
            
            if (!res || !res.data || !res.data.data || res.data.data.length === 0) {
                keepFetching = false;
                break;
            }

            const klines = res.data.data;
            klines.reverse(); 

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
            startTime = parseInt(klines[klines.length - 1][0]);
            
            // LA CLAVE ESTÁ ACÁ: Ahora somos mucho más permisivos. 
            // Solo cortamos el bucle si KuCoin devuelve menos de 10 velas (estamos en vivo).
            // Si devuelve 1499, sigue adelante.
            if (klines.length < 10) {
                keepFetching = false;
            } else if (isDeepFetch) {
                // Si estamos en MODO TURBO llenando la base, imprimimos el progreso parcial
                process.stdout.write(`\r   [*] ${dbSymbol} Progreso: ${totalSavedInThisSession} velas descargadas...`);
                // Le damos 1 segundo de pausa a KuCoin para que no nos banee la IP
                await new Promise(r => setTimeout(r, 1000)); 
            } else {
                // Modo mantenimiento normal (solo actualizando velas recientes)
                await new Promise(r => setTimeout(r, 500));
            }
        }
        // El salto de línea borra el progreso temporal y deja el mensaje final OK
        console.log(`\n   [OK] ${dbSymbol} sincronizado (+${totalSavedInThisSession} velas).`);
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

runCollector();
