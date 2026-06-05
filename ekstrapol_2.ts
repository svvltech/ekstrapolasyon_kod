
import * as Cesium from "cesium";

export class MovementEngine {
    
    private Son_Gercek_Konum = new Cesium.Cartesian3();

    private Rota_Acisi: number = 0;     // trackAngle -Gerçek ilerleme rotası (Fiziksel)
    private Son_Rota_Acisi: number = 0; // lastTrackAngle -Bir önceki rotanın açısı
    private Rota_Donus_Hizi: number = 0;  // trackTurnRate -Rota üzerindeki dönüş hızı (rad/s)

    private Son_Pruva_Acisi: number = 0; // lastHeading
    private Pruva_Donus_Hizi: number = 0;    // turnRate - Dönüş hızı (rad/s) 

    private Son_Irtifa: number = 0;   // lastAlt (m)
    private Yunuslama_Acisi: number = 0; // lastPitch (rad)
    private Yatis_Acisi: number = 0;  // lastRoll (rad)

    private Yunuslama_Hizi: number = 0; // pitchRate rad/s
    private Yatis_Hizi: number = 0;  // rollRate rad/s
    private Dikey_Hiz: number = 0;      // Hesaplanan dikey hız (m/s)

    private Yatay_Hiz: number = 0;       // Yatay hız büyüklüğü (m/s) — ECEF vektöründen
    private Paket_Sayisi: number = 0; // Gelen paket sayısı — ilk 2 pakete kadar tahmin yapılmaz

    // visual state
    private Guncel_Gorsel_Konum = new Cesium.Cartesian3();
    private Guncel_Gorsel_Yonelim = new Cesium.Quaternion();

    // --- HİBRİT ZAMAN YÖNETİMİ MİMARİSİ (Live + Replay & Timer) ---
    private Son_Sunucu_Zamani: number = 0; // Paketten gelen son_sunucu_saati (Fiziğin Saati)
    private Son_Paket_Yerel_Zamanı: number = 0; // performance.now() milisaniyesi (Ağın Ritmi ve Kronometre)
    private Ortalama_Paket_Suresi: number = 0.2; // Ağın ortalama paket süresi (Varsayılan 200ms)

    private Konum_Hatasi = new Cesium.Cartesian3(); // Hedef ile Görsel arasındaki Konum Hatası
    private Yonelim_Hatasi = new Cesium.Quaternion(); // Hedef ile Görsel arasındaki Açı Hatası
    
    // VERİ ZAMAN AŞIMI VE HAFIZA 
    private readonly MAKS_TAHMIN_SURESI = 3.0;
    private readonly HAFIZA_TEMIZLEME_SURESI = 3.0;

    // --- PERFORMANS SCRATCHPAD (Sıfır Çöp Üretimi) ---
    private static readonly _sMoveEnu = new Cesium.Cartesian3();
    private static readonly _sMoveEcef = new Cesium.Cartesian3();
    private static readonly _sTargetPos = new Cesium.Cartesian3();
    private static readonly _sEnuMatrix = new Cesium.Matrix4();
    private static readonly _sHpr = new Cesium.HeadingPitchRoll();
    private static readonly _sNewQuat = new Cesium.Quaternion();
    private static readonly _sInvEnuMatrix = new Cesium.Matrix4();
    private static readonly _sTrackDiff = new Cesium.Cartesian3(); 
    private static readonly _sTrackEnu = new Cesium.Cartesian3();  
    private static readonly _sNewPos = new Cesium.Cartesian3();    
    private static readonly _sInvNewQuat = new Cesium.Quaternion();
    private static readonly _sDecayedOriError = new Cesium.Quaternion();
    
    constructor(initialLon: number, initialLat: number, initialHeight: number, initialH: number = 0, initialP: number = 0, initialR: number = 0) {
        // Verilen derece cinsinden coğrafi konumu Cesium'un kullandığı ECEF koordinatlarına çevirir
        Cesium.Cartesian3.fromDegrees(initialLon, initialLat, initialHeight, Cesium.Ellipsoid.WGS84, this.Guncel_Gorsel_Konum);
        Cesium.Cartesian3.clone(this.Guncel_Gorsel_Konum, this.Son_Gercek_Konum);

        // Başlangıç yönelimini (HPR) Quaternion'a çevir ve ayarla
        MovementEngine._sHpr.heading = initialH;
        MovementEngine._sHpr.pitch = initialP;
        MovementEngine._sHpr.roll = initialR;
        Cesium.Transforms.headingPitchRollQuaternion(this.Guncel_Gorsel_Konum, MovementEngine._sHpr, Cesium.Ellipsoid.WGS84, Cesium.Transforms.eastNorthUpToFixedFrame, this.Guncel_Gorsel_Yonelim);

        this.Son_Irtifa = initialHeight;
        this.Son_Pruva_Acisi = initialH;
        this.Yunuslama_Acisi = initialP;
        this.Yatis_Acisi = initialR;
        this.Rota_Acisi = initialH;
        this.Son_Rota_Acisi = initialH;

        // Kronometreyi yüksek hassasiyetle başlat
        this.Son_Paket_Yerel_Zamanı = performance.now();
        
        Cesium.Cartesian3.ZERO.clone(this.Konum_Hatasi);
        Cesium.Quaternion.IDENTITY.clone(this.Yonelim_Hatasi);
    }

    /**
     * Sunucudan yeni paket geldiğinde çalışır.
     * @param son_sunucu_saati : Simülasyon zamanı saniye cinsinden (Örn: 2345.34) 
     */
    public onPacketReceived(lon: number, lat: number, alt: number, yatay_Hiz: number, h: number, p: number, r: number, son_sunucu_saati: number) {

        // 1. Sayısal Güvenlik (Geçersiz veriyi doğrudan çöpe at)
        if (![lon, lat, alt, yatay_Hiz, h, p, r, son_sunucu_saati].every(Number.isFinite)) {
            console.warn(`[MovementEngine] Geçersiz Sayı (NaN/Inf) Tespit Edildi!`);
            return;
        }

        const localNow = performance.now(); // Yüksek hassasiyetli yerel kronometre

        // 2. İLK PAKET (Motorun Uyanışı)
        if (this.Son_Sunucu_Zamani === 0) {
            this.Son_Sunucu_Zamani = son_sunucu_saati;
            this.Son_Paket_Yerel_Zamanı = localNow;
            this.forceSync(lon, lat, alt, yatay_Hiz, h, p, r);
            return;
        }

        // 3. KAYIT GERİYE SARILDI (Rewind) KONTROLÜ
        if (son_sunucu_saati < this.Son_Sunucu_Zamani) {
            console.log(`[MovementEngine] Kayıt Geriye Sarıldı! Motor Işınlanıyor.`);
            this.Son_Sunucu_Zamani = son_sunucu_saati;
            this.Son_Paket_Yerel_Zamanı = localNow;
            this.forceSync(lon, lat, alt, yatay_Hiz, h, p, r);
            return;
        }

        // 4. KAYIT DURAKLATILDI (Pause Spam Koruması)
        if (son_sunucu_saati === this.Son_Sunucu_Zamani) {
            // Kayıt durduğu için sunucu aynı paketi atıyor.
            // Kronometreyi sıfırlıyoruz ki uçağın ekstrapolasyonu 0 olsun ve kilitlensin.
            // Bu sıfırlama, uçağın haksız yere "Ağ Koptu (Timeout)" zannetmesini de engeller.
            this.Son_Paket_Yerel_Zamanı = localNow; 
            return; 
        }

        // --- 5. AĞIN RİTMİ (dtLocal) - Lag ve Ping Tespiti ---
        let dtLocal = 0;
        if (this.Paket_Sayisi > 0) {
            dtLocal = (localNow - this.Son_Paket_Yerel_Zamanı) / 1000.0;
            // Aşırı uçları kırparak (50ms - 2sn arası) ağın ortalama geliş hızını bul
            const clampedDt = Math.max(0.05, Math.min(dtLocal, 2.0));
            this.Ortalama_Paket_Suresi = (this.Ortalama_Paket_Suresi * 0.8) + (clampedDt * 0.2);
        }

        // --- 6. FİZİKSEL ZAMAN (dtPacket) ---
        // Uçağın ivmesini hesaplarken lagları değil, orijinal fiziksel üretim zamanını kullanırız
        const dtPacket = son_sunucu_saati - this.Son_Sunucu_Zamani;

        // Kronometreleri ve zamanı güncelle
        this.Son_Sunucu_Zamani = son_sunucu_saati;
        this.Son_Paket_Yerel_Zamanı = localNow; 

        // 7. ZAMAN AŞIMI (Timeout) ve HAFIZA TEMİZLİĞİ
        // Zaman aşımını gerçek geçen süreye (dtLocal) göre kontrol ediyoruz
        if (dtLocal > this.MAKS_TAHMIN_SURESI && this.Paket_Sayisi > 0) {
            console.log(`[MovementEngine] ${dtLocal.toFixed(1)}s LAG -> Bağlantı koptu/gecikti, ForceSync yapılıyor.`);
            this.forceSync(lon, lat, alt, yatay_Hiz, h, p, r);
            return; 
        }

        if (dtLocal > this.HAFIZA_TEMIZLEME_SURESI && this.Paket_Sayisi > 0) {
            console.log(`[MovementEngine] ${dtLocal.toFixed(1)}s boşluk → Tahmin verileri sıfırlanıyor.`);
            this.Pruva_Donus_Hizi = 0;
            this.Rota_Donus_Hizi = 0;
            this.Yunuslama_Hizi = 0;
            this.Yatis_Hizi = 0;
            this.Dikey_Hiz = 0;
            this.Paket_Sayisi = 1; // 1 yapılarak baştan hız hesabı yapması sağlanır
        }
        
        // Yeni Konum (ECEF)
        this.Paket_Sayisi++;
        const newPos = Cesium.Cartesian3.fromDegrees(lon, lat, alt, Cesium.Ellipsoid.WGS84, MovementEngine._sNewPos);
        
                // --- KONUM ÖLÜ BÖLGESİ (Jitter/Titreme Koruması) ---
                const gercekMesafe3D = Cesium.Cartesian3.distance(this.Son_Gercek_Konum, newPos);
                if (gercekMesafe3D < 0.001) { 
                    yatay_Hiz = 0; // Sunucu hız gönderse bile float hatasıysa hızı sıfırla
                    Cesium.Cartesian3.clone(this.Son_Gercek_Konum, newPos); 
                }

        // --- FİZİK VE DÖNÜŞ HIZI HESAPLAMALARI ---
        if (dtPacket > 0.01) {
            const diff = Cesium.Cartesian3.subtract(newPos, this.Son_Gercek_Konum, MovementEngine._sTrackDiff);          
            Cesium.Transforms.eastNorthUpToFixedFrame(this.Son_Gercek_Konum, Cesium.Ellipsoid.WGS84, MovementEngine._sEnuMatrix);
            const invEnu = Cesium.Matrix4.inverse(MovementEngine._sEnuMatrix, MovementEngine._sInvEnuMatrix);
            const localDiff = Cesium.Matrix4.multiplyByPointAsVector(invEnu, diff, MovementEngine._sTrackEnu);

            const moveDist = Math.hypot(localDiff.x , localDiff.y); // Z ekseni hariç yatay yer değiştirme
            let rawTrackTurnRate = 0; 

            // 1. DURMA KONTROLÜ (Hizalama - Alignment)
            if (this.Yatay_Hiz < 2.0) { 
                rawTrackTurnRate = 0; 
                this.Rota_Acisi = h; // Atan2 gürültüsünü engellemek için rotayı burna kilitle
            }
            // 2. GÜRÜLTÜ / BURST KONTROLÜ (Yan uçuşu / Crab Flight koruması)
            else if (moveDist < 1.5) {
                // Mesafe yeni kavis hesaplamak için çok kısa. Eski istikrarı bozma.
                rawTrackTurnRate = this.Rota_Donus_Hizi; 
            }
            // 3. NORMAL
            else {
                this.Rota_Acisi = Math.atan2(localDiff.x, localDiff.y);  
                if (this.Paket_Sayisi > 2) {
                    let deltaT = this.Rota_Acisi - this.Son_Rota_Acisi;
                    if (deltaT > Math.PI) deltaT -= Math.PI * 2;
                    if (deltaT < -Math.PI) deltaT += Math.PI * 2;
                    rawTrackTurnRate = deltaT / dtPacket;
                }
            }       
            
            let rawDikeyHiz = (alt - this.Son_Irtifa) / dtPacket;
            let rawTurnRate = 0;
            let rawPitchRate = 0;
            let rawRollRate = 0;

            if (this.Paket_Sayisi > 2) {
                // Güvenli Payda: Sensör çıldırsa bile ağın ortalama hızına güvenerek patlamayı önle
                const safeDt = Math.max(dtPacket, this.Ortalama_Paket_Suresi * 0.5);

                let deltaH = h - this.Son_Pruva_Acisi;
                if (deltaH > Math.PI) deltaH -= Math.PI * 2;
                if (deltaH < -Math.PI) deltaH += Math.PI * 2;
                if(Math.abs(deltaH) < 0.008) deltaH = 0; // Açısal ölü bölge (Deadband)
                rawTurnRate = deltaH / safeDt;

                let deltaP = p - this.Yunuslama_Acisi;
                if (deltaP > Math.PI) deltaP -= Math.PI * 2;
                if (deltaP < -Math.PI) deltaP += Math.PI * 2;
                if(Math.abs(deltaP) < 0.008) deltaP = 0;
                rawPitchRate = deltaP / safeDt;

                let deltaR = r - this.Yatis_Acisi;
                if (deltaR > Math.PI) deltaR -= Math.PI * 2;
                if (deltaR < -Math.PI) deltaR += Math.PI * 2;
                if(Math.abs(deltaR) < 0.008) deltaR = 0;
                rawRollRate = deltaR / safeDt;
            }

            // --- FİLTRELEME (EMA - Hareketli Ortalama) ---
            if (this.Paket_Sayisi <= 3 || dtPacket > this.HAFIZA_TEMIZLEME_SURESI) {
                this.Rota_Donus_Hizi = rawTrackTurnRate;
                this.Pruva_Donus_Hizi = rawTurnRate;
                this.Yunuslama_Hizi = rawPitchRate;
                this.Yatis_Hizi = rawRollRate;
                this.Dikey_Hiz = rawDikeyHiz;
            } else {
                this.Rota_Donus_Hizi = (this.Rota_Donus_Hizi * 0.8) + (rawTrackTurnRate * 0.2);
                this.Dikey_Hiz = (this.Dikey_Hiz * 0.8) + (rawDikeyHiz * 0.2);
                // Kontrol Yüzeyleri: EMA iptal, pilot manevrayı bitirdiği an dönüş dursun
                this.Pruva_Donus_Hizi = rawTurnRate; 
                this.Yunuslama_Hizi = rawPitchRate; 
                this.Yatis_Hizi = rawRollRate; 
            }
        }

        MovementEngine._sHpr.heading = h;
        MovementEngine._sHpr.pitch = p;
        MovementEngine._sHpr.roll = r;
        const newQuat = Cesium.Transforms.headingPitchRollQuaternion(newPos, MovementEngine._sHpr, Cesium.Ellipsoid.WGS84, Cesium.Transforms.eastNorthUpToFixedFrame, MovementEngine._sNewQuat);

        // --- HATA VEKTÖRÜNÜ YAKALA VE BAŞLANGIÇ KANCASINI ÖNLE ---
        if (this.Paket_Sayisi <= 2) {
            // İlk paketlerde yumuşatma yapma, aracı eski yerinden (veya merkezden) lastik gibi çekme
            Cesium.Cartesian3.ZERO.clone(this.Konum_Hatasi);
            Cesium.Quaternion.IDENTITY.clone(this.Yonelim_Hatasi);
            Cesium.Cartesian3.clone(newPos, this.Guncel_Gorsel_Konum);
            Cesium.Quaternion.clone(newQuat, this.Guncel_Gorsel_Yonelim);
        } else {
            // Vektörel Hata: Görsel şu an asıl hedeften ne kadar uzakta?
            Cesium.Cartesian3.subtract(this.Guncel_Gorsel_Konum, newPos, this.Konum_Hatasi);
            
            // Rotasyonel Hata: Bükülme farkı (Inverse Quat Çarpımı)
            const invNewQuat = Cesium.Quaternion.inverse(newQuat, MovementEngine._sInvNewQuat);
            Cesium.Quaternion.multiply(this.Guncel_Gorsel_Yonelim, invNewQuat, this.Yonelim_Hatasi);

            // GÜVENLİK FRENLERİ (Snap/Işınlanma Sınırları)
            if (Cesium.Cartesian3.magnitude(this.Konum_Hatasi) > 500.0) {
                Cesium.Cartesian3.ZERO.clone(this.Konum_Hatasi);
                Cesium.Cartesian3.clone(newPos, this.Guncel_Gorsel_Konum);
            }

            const nokta_carpim = Cesium.Quaternion.dot(this.Guncel_Gorsel_Yonelim, newQuat);
            const aci_farki_radyan = 2.0 * Math.acos(Math.min(Math.abs(nokta_carpim),1.0));
            if ( aci_farki_radyan > 45.0) {
                Cesium.Quaternion.IDENTITY.clone(this.Yonelim_Hatasi);
                Cesium.Quaternion.clone(newQuat, this.Guncel_Gorsel_Yonelim);                
            }
        }

        this.Son_Rota_Acisi = this.Rota_Acisi;
        this.Son_Irtifa = alt;
        this.Son_Pruva_Acisi = h;
        this.Yunuslama_Acisi = p;
        this.Yatis_Acisi = r;
        this.Yatay_Hiz = yatay_Hiz;

        // Gelecek döngü için temel dayanak noktasını kaydet
        Cesium.Cartesian3.clone(newPos, this.Son_Gercek_Konum);
    }

    public Guncel_Konumu_Getir(result: Cesium.Cartesian3): Cesium.Cartesian3 {
        if((this.Son_Gercek_Konum.x===0 && this.Son_Gercek_Konum.y===0 && this.Son_Gercek_Konum.z===0) 
            || !Number.isFinite(this.Son_Gercek_Konum.x) || !Number.isFinite(this.Son_Gercek_Konum.y) || !Number.isFinite(this.Son_Gercek_Konum.z))
        {
            return Cesium.Cartesian3.clone(this.Son_Gercek_Konum , this.Guncel_Gorsel_Konum);
        }

        // KRONOMETRE ZAMANI (performance.now ile yüksek hassasiyetli dtSincePacket)
        const localNow = performance.now();
        let dtSincePacket = (localNow - this.Son_Paket_Yerel_Zamanı) / 1000.0;
        
        if (dtSincePacket < 0) dtSincePacket = 0;
        if (dtSincePacket > this.MAKS_TAHMIN_SURESI){
            // Veri gelmiyor veya oyun duraklatılmış, tahmin yapmayı bırak ve modeli kilitle
            return Cesium.Cartesian3.clone(this.Guncel_Gorsel_Konum ,result);
        } 

        // 1. EKSTRAPOLASYON (Kusursuz Hayalet Hedefi Hesapla)
        const targetPos = Cesium.Cartesian3.clone(this.Son_Gercek_Konum, MovementEngine._sTargetPos);

        if (dtSincePacket > 0 && this.Yatay_Hiz > 1.0 && this.Paket_Sayisi >= 2) {
            const moveEnu = MovementEngine._sMoveEnu;
            
            // Eğer dönüş hızı çok küçükse (düz uçuş), sıfıra bölme hatasını önlemek için lineer (kiriş) yaklaşım
            if (Math.abs(this.Rota_Donus_Hizi) < 0.001) {
                const predictedTrack = this.Rota_Acisi + (this.Rota_Donus_Hizi * dtSincePacket);
                moveEnu.x = Math.sin(predictedTrack) * this.Yatay_Hiz * dtSincePacket; // Doğu ekseni
                moveEnu.y = Math.cos(predictedTrack) * this.Yatay_Hiz * dtSincePacket; // Kuzey ekseni
            } else {
                // Uçak virajdaysa CTRV (Yay İntegrali) kavis modeli
                const theta0 = this.Rota_Acisi;
                const theta1 = theta0 + (this.Rota_Donus_Hizi * dtSincePacket);
                const R = this.Yatay_Hiz / this.Rota_Donus_Hizi; 

                moveEnu.x = R * (Math.cos(theta0) - Math.cos(theta1)); 
                moveEnu.y = R * (Math.sin(theta1) - Math.sin(theta0)); 
            }

            moveEnu.z = this.Dikey_Hiz * dtSincePacket;

            Cesium.Transforms.eastNorthUpToFixedFrame(this.Son_Gercek_Konum, Cesium.Ellipsoid.WGS84, MovementEngine._sEnuMatrix);
            Cesium.Matrix4.multiplyByPointAsVector(MovementEngine._sEnuMatrix, moveEnu, MovementEngine._sMoveEcef);
            Cesium.Cartesian3.add(targetPos, MovementEngine._sMoveEcef, targetPos);
        }

        // 2. SÖNÜMLEME (Hata Yayını Eritme - Error Blending)
        const pozisyon_hatasi_buyukluk = Cesium.Cartesian3.magnitude(this.Konum_Hatasi);
        let sonumleme_carpani = 3.0; 
        
        // Araç yavaşsa ve hata küçükse (İniş veya Taksi durumu) amortisörü yumuşat
        if(this.Yatay_Hiz < 5.0){
            if(pozisyon_hatasi_buyukluk < 0.5){
                sonumleme_carpani = 0.5;
            } else {
                sonumleme_carpani = 1.0;
            }
        }
        
        const safeBlendDuration = this.Ortalama_Paket_Suresi; 
        const Sonumleme_Hizi = sonumleme_carpani / safeBlendDuration; 
        let Sonumleme_Katsayisi = Math.exp(-Sonumleme_Hizi * dtSincePacket);
        
        if(Sonumleme_Katsayisi > 0.99) Sonumleme_Katsayisi = 0.99;

        // Görsel Konum = Kusursuz Tahmin (TargetPos) + Eriyen Hata
        const currentError = Cesium.Cartesian3.multiplyByScalar(this.Konum_Hatasi, Sonumleme_Katsayisi, MovementEngine._sMoveEcef);
        Cesium.Cartesian3.add(targetPos, currentError, this.Guncel_Gorsel_Konum);

        return Cesium.Cartesian3.clone(this.Guncel_Gorsel_Konum, result);
    }
    
    public Guncel_Yonelimi_Getir(result: Cesium.Quaternion): Cesium.Quaternion {
        if(!Number.isFinite(this.Guncel_Gorsel_Konum.x) || !Number.isFinite(this.Guncel_Gorsel_Konum.y) || !Number.isFinite(this.Guncel_Gorsel_Konum.z))
        {
            return Cesium.Quaternion.clone( this.Guncel_Gorsel_Yonelim , result);
        }

        const localNow = performance.now();
        let dtSincePacket = (localNow - this.Son_Paket_Yerel_Zamanı) / 1000.0;
        if (dtSincePacket < 0) dtSincePacket = 0;
        if (dtSincePacket > this.MAKS_TAHMIN_SURESI) dtSincePacket = this.MAKS_TAHMIN_SURESI;

        // Açıların Ekstrapolasyonu (HPR'ı geleceğe doğru bük)
        const predictedHeading = this.Son_Pruva_Acisi + (this.Pruva_Donus_Hizi * dtSincePacket);
        const predictedPitch = this.Yunuslama_Acisi + (this.Yunuslama_Hizi * dtSincePacket);
        const predictedRoll = this.Yatis_Acisi + (this.Yatis_Hizi * dtSincePacket);

        MovementEngine._sHpr.heading = predictedHeading;
        MovementEngine._sHpr.pitch = predictedPitch;
        MovementEngine._sHpr.roll = predictedRoll;

        const predictedQuat = Cesium.Transforms.headingPitchRollQuaternion(
            this.Guncel_Gorsel_Konum, MovementEngine._sHpr,
            Cesium.Ellipsoid.WGS84, Cesium.Transforms.eastNorthUpToFixedFrame,
            MovementEngine._sNewQuat
        );

        // Açısal Hatanın Sönümlenmesi (SLERP)
        const oryatasyon_hatasi_buyukluk = Cesium.Cartesian3.magnitude(this.Yonelim_Hatasi);
        let sonumleme_carpani = 3.0; 
        if(this.Yatay_Hiz < 5.0){
            if(oryatasyon_hatasi_buyukluk < 0.5){
                sonumleme_carpani = 0.5; 
            } else {
                sonumleme_carpani = 1.0;
            }
        }
        
        const safeBlendDuration = Math.max(this.Ortalama_Paket_Suresi, 0.2); 
        const Sonumleme_Hizi = sonumleme_carpani / safeBlendDuration; 
        let Sonumleme_Katsayisi = Math.exp(-Sonumleme_Hizi * dtSincePacket);
        if(Sonumleme_Katsayisi > 0.99) Sonumleme_Katsayisi = 0.99;

        // IDENTITY (Sıfır hata) durumuna doğru küresel yumuşatma
        const decayedOriError = Cesium.Quaternion.slerp(Cesium.Quaternion.IDENTITY, this.Yonelim_Hatasi, Sonumleme_Katsayisi, MovementEngine._sDecayedOriError);
        
        // Görsel Yönelim = Eriyen Bükülme Hatası * Kusursuz Yönelim
        Cesium.Quaternion.multiply(decayedOriError, predictedQuat, this.Guncel_Gorsel_Yonelim);

        return Cesium.Quaternion.clone(this.Guncel_Gorsel_Yonelim, result);
    }

    private forceSync(lon: number, lat: number, alt: number, speed: number, h: number, p: number, r: number) {
        const posEcef = Cesium.Cartesian3.fromDegrees(lon, lat, alt, Cesium.Ellipsoid.WGS84, MovementEngine._sNewPos);
        
        // Temel referansları hedefe zımbala
        Cesium.Cartesian3.clone(posEcef, this.Son_Gercek_Konum);
        Cesium.Cartesian3.clone(posEcef, this.Guncel_Gorsel_Konum);
        
        const quat = this.calculateQuaternion(posEcef, h, p, r);
        Cesium.Quaternion.clone(quat, this.Guncel_Gorsel_Yonelim);

        // Tahmin motorunu (İvmeleri ve hızları) sıfırla
        this.Paket_Sayisi = 0;
        this.Pruva_Donus_Hizi = 0;
        this.Rota_Donus_Hizi = 0;
        this.Yunuslama_Hizi = 0;
        this.Yatis_Hizi = 0;
        this.Dikey_Hiz = 0;
        this.Yatay_Hiz = speed;
        this.Son_Irtifa = alt;
        this.Son_Pruva_Acisi = h;
        this.Yunuslama_Acisi = p;
        this.Yatis_Acisi = r;

        // Amortisör yaylarını (Hata vektörlerini) sıfırla ki çekilme efekti olmasın
        Cesium.Cartesian3.ZERO.clone(this.Konum_Hatasi);
        Cesium.Quaternion.IDENTITY.clone(this.Yonelim_Hatasi);
    }

    private calculateQuaternion(position: Cesium.Cartesian3, h: number, p: number, r: number): Cesium.Quaternion {
        const hpr = MovementEngine._sHpr;
        hpr.heading = h;
        hpr.pitch = p;
        hpr.roll = r;

        return Cesium.Transforms.headingPitchRollQuaternion(
            position,
            hpr,
            Cesium.Ellipsoid.WGS84,
            Cesium.Transforms.eastNorthUpToFixedFrame,
            MovementEngine._sNewQuat
        );
    }
}
