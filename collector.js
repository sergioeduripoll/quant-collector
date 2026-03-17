const { createClient } = require('@supabase/supabase-client');
const axios = require('axios');

// Configuración de Supabase (usá tus variables de entorno)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ASSETS = ['BTCUSDT', 'ETHUSDT', 'ADAUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT'];
const INTERVAL = '5m';
const MAX_CANDLES = 50000;

// Función para obtener velas de Binance
async function fetchBinance(symbol, limit = 1000) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${limit}`;
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
}

// Lógica de sincronización con Ventana Deslizante
async function syncAsset(symbol) {
    try {
        console.log(`[PROCESO] Sincronizando ${symbol}...`);

        // 1. Traer las últimas velas de Binance
        const candles = await fetchBinance(symbol, 1000);

        // 2. UPSERT: Insertar o actualizar para evitar duplicados
        const { error: upsertError } = await supabase
            .from('candles')
            .upsert(candles, { onConflict: 'symbol,timestamp' });

        if (upsertError) throw upsertError;

        // 3. MANTENIMIENTO: Borrar excedente (Límite 50,000)
        // Buscamos el timestamp de la vela 50k para usarlo de guillotina
        const { data: limitCandle } = await supabase
            .from('candles')
            .select('timestamp')
            .eq('symbol', symbol)
            .order('timestamp', { ascending: false })
            .range(MAX_CANDLES, MAX_CANDLES)
            .single();

        if (limitCandle) {
            const { error: deleteError } = await supabase
                .from('candles')
                .delete()
                .eq('symbol', symbol)
                .lt('timestamp', limitCandle.timestamp);
            
            if (deleteError) console.error(`[LIMPIEZA] Error en ${symbol}:`, deleteError);
            else console.log(`[OK] ${symbol}: Base de datos purgada.`);
        }

        console.log(`[EXITO] ${symbol} al día.`);
    } catch (err) {
        console.error(`[ERROR] Falló ${symbol}:`, err.message);
    }
}

// Ciclo principal
async function run() {
    console.log("🚀 Iniciando Ciclo de Recolección Institucional...");
    for (const asset of ASSETS) {
        await syncAsset(asset);
        // Pequeño delay para no saturar la API
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log("✅ Ciclo completado. Durmiendo 5 min...");
}

// Ejecutar cada 5 minutos
run();
setInterval(run, 5 * 60 * 1000);
