const { createClient } = require('@supabase/supabase-client');
const axios = require('axios');

// Agisayangkat ti husto a huli (Variables de entorno)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ASSETS = ['BTCUSDT', 'ETHUSDT', 'ADAUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT'];
const INTERVAL = '5m';
const MAX_CANDLES = 50000;
const BATCH_SIZE = 2000; // Cargamos de a 2000 para no romper Render

async function fetchBinance(symbol, limit = 1000, endTime = null) {
    try {
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${limit}`;
        if (endTime) url += `&endTime=${endTime}`;
        const res = await axios.get(url);
        return res.data.map(d => ({
            symbol: symbol,
            interval: INTERVAL,
            timestamp: d[0],
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5])
        }));
    } catch (e) {
        console.error(`⚠️ Binance error en ${symbol}: ${e.message}`);
        return [];
    }
}

async function syncAsset(symbol) {
    try {
        // 1. Conteo actual
        const { count, error: cErr } = await supabase
            .from('candles')
            .select('*', { count: 'exact', head: true })
            .eq('symbol', symbol);
        
        if (cErr) throw cErr;
        console.log(`[STATUS] ${symbol}: ${count || 0} velas.`);

        // 2. Llenado Progresivo (Cargamos un lote por cada ejecución)
        if ((count || 0) < MAX_CANDLES) {
            console.log(`[LLENADO] Cargando lote histórico para ${symbol}...`);
            let loadedInThisCycle = 0;
            
            while (loadedInThisCycle < BATCH_SIZE) {
                const { data: oldest } = await supabase.from('candles').select('timestamp').eq('symbol', symbol).order('timestamp', { ascending: true }).limit(1).single();
                const endTime = oldest ? oldest.timestamp - 1 : null;
                
                const historical = await fetchBinance(symbol, 1000, endTime);
                if (historical.length === 0) break;

                const { error: insErr } = await supabase.from('candles').upsert(historical);
                if (insErr) throw insErr;

                loadedInThisCycle += historical.length;
                await new Promise(r => setTimeout(r, 300)); // Respiro para Binance
            }
        }

        // 3. Update tiempo real
        const fresh = await fetchBinance(symbol, 50);
        await supabase.from('candles').upsert(fresh, { onConflict: 'symbol,timestamp' });

        // 4. Guillotina (Mantener 50k)
        const { data: threshold } = await supabase.from('candles').select('timestamp').eq('symbol', symbol).order('timestamp', { ascending: false }).range(MAX_CANDLES, MAX_CANDLES).single();
        if (threshold) {
            await supabase.from('candles').delete().eq('symbol', symbol).lt('timestamp', threshold.timestamp);
            console.log(`[PURGA] ${symbol} al día.`);
        }

    } catch (err) {
        console.error(`[BIDDUT/ERROR] ${symbol}: ${err.message}`);
    }
}

async function run() {
    console.log(`[${new Date().toLocaleString()}] 🚀 Iniciando ciclo de recolección...`);
    for (const asset of ASSETS) {
        await syncAsset(asset);
        await new Promise(r => setTimeout(r, 500));
    }
    console.log("✅ Ciclo terminado. Esperando 2 minutos para el próximo lote...");
}

// Ejecución más frecuente para llenar rápido pero sin crashes
run();
setInterval(run, 2 * 60 * 1000);
