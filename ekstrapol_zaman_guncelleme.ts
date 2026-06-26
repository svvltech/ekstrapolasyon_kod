import * as Cesium from "cesium";


export class MovementEngine {

    private Son_Gercek_Konum = new Cesium.Cartesian3();

    private Rota_Acisi: number = 0;     // trackAngle - Gerçek ilerleme rotası (Fiziksel)
    private Son_Rota_Acisi: number = 0; // lastTrackAngle - Bir önceki rotanın açısı
    private Rota_Donus_Hizi: number = 0;  // trackTurnRate - Rota üzerindeki dönüş hızı (rad/s)

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

    // --- ZAMAN YÖNETİMİ ---
    // Sunucu zamanı: Simülasyon saati (saniye cinsinden float, ör: 1234.567)
    // Sadece fizik oranları (hız, dönüş hızı) hesaplamak için kullanılır.
    // Offset YOK — farklı epoch'lar arasında offset tutmak EMA drift sorunlarına yol açar.
    private Son_Sunucu_Zamani: number = 0; // lastServerTime (saniye, float)

    // Yerel kronometre: Son geçerli paketin geldiği an (performance.now() ms)
    // Hem ekstrapolasyon hem sönümleme bu tek dt'yi kullanır.
    // Monoton artan performance.now() sayesinde dt her zaman düzgün ilerler.
    private Son_Paket_Yerel_Zamanı: number = 0; // lastPacketLocalTime (ms)

    // Ağın Ritmi ve Hata Yönetimi
    private Ortalama_Paket_Suresi: number = 0.2; // avgPacketDt - Sunucu zamanında paket aralığı (Varsayılan 200ms)

    // --- OYNATMA HIZI ORANI (Zaman Çarpanı) ---
    // Simülasyon zamanı / Gerçek zaman oranı. Dinamik olarak hesaplanır.
    // 1x → 1.0, 8x → 8.0, 0.5x → 0.5
    // Ekstrapolasyon simDt = realDt × Zaman_Carpani ile simülasyon zamanına çevrilir.
    // Böylece oynatma hızından bağımsız doğru tahmin yapılır.
    private Zaman_Carpani: number = 1.0;
    private Konum_Hatasi = new Cesium.Cartesian3(); // Hedef ile Görsel arasındaki Konum Hatası
    private Yonelim_Hatasi = new Cesium.Quaternion(); // Hedef ile Görsel arasındaki Açı Hatası

    // VERİ ZAMAN AŞIMI:
    // MAKS_TAHMIN_SURESI saniye boyunca veri gelmezse ekstrapolasyon durur.
    // MAKS_TAHMIN_SURESI saniye sonra gelen veri forceSync ile aracı yeni konumdan başlatır.
    // MAKS_TAHMIN_SURESI saniye içinde gelen veri normal kabul edilir, süzülerek yetişir.
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
    private static readonly _sTrackDiff = new Cesium.Cartesian3(); // Track hesabı için (onPacketReceived)
    private static readonly _sTrackEnu = new Cesium.Cartesian3();  // Track ENU dönüşümü için
    private static readonly _sNewPos = new Cesium.Cartesian3();    // onPacketReceived için ayrı konum scratchpad
    private static readonly _sNewPosValid = new Cesium.Cartesian3();    // isValidPacket konum kontrolü için
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

        // Yerel kronometre: performance.now() kullanıyoruz (Date.now() yerine)
        // performance.now() sayfa açıldığından beri geçen süreyi verir, monoton artar
        this.Son_Paket_Yerel_Zamanı = performance.now();

        Cesium.Cartesian3.ZERO.clone(this.Konum_Hatasi);
        Cesium.Quaternion.IDENTITY.clone(this.Yonelim_Hatasi);
    }



    /**
     * Sunucudan yeni paket geldiğinde çalışır.
     * @param lon, lat, alt : Konum (Derece, Derece, Metre)
     * @param yatay_Hiz : Yatay hız (m/s)
     * @param h, p, r : Heading, Pitch, Roll (Radyan cinsinden)
     * @param son_sunucu_saati_sn : Simülasyon zamanı saniye cinsinden float (Örn: 1234.567)
     */
    public onPacketReceived(lon: number, lat: number, alt: number, yatay_Hiz: number, h: number, p: number, r: number, son_sunucu_saati_sn: number) {

        const localNow = performance.now(); // Yüksek hassasiyetli yerel kronometre

        // ═══════════════════════════════════════════════════════════════
        //  ADIM 1: PAKET VALİDASYONU (inline — isValidPacket yerine)
        // ═══════════════════════════════════════════════════════════════

        // 1a. Sayısal Güvenlik: NaN veya Infinity tespiti
        if (![lon, lat, alt, yatay_Hiz, h, p, r, son_sunucu_saati_sn].every(Number.isFinite)) {
            console.warn(`[MovementEngine] Geçersiz Sayı (NaN/Inf) Tespit Edildi!`);
            return;
        }

        // 1b. AYNI SUNUCU SAATİ → Simülasyon duraklatılmış veya mükerrer paket
        //     Hiçbir state güncellenmez! Son_Paket_Yerel_Zamanı da güncellenmez
        //     ki render döngüsünde dtSincePacket doğal olarak artıp 3s sonra donsun.
        //     Son_Paket_Yerel_Zamanı güncellenirse uçak her 200ms'de sıfırdan
        //     ekstrapolasyona başlar → ileri-geri salınım yapar.
        if (son_sunucu_saati_sn === this.Son_Sunucu_Zamani) {
            return;
        }

        // 1c. İLK PAKET: Motor henüz hiç veri almamış
        //     server_time ne olursa olsun (0.5 veya 12345) forceSync ile temiz başla.
        //     Bu kontrol olmadan, constructor konumundan çöp fizik hesaplanır.
        if (this.Son_Sunucu_Zamani === 0) {
            this.forceSync(lon, lat, alt, yatay_Hiz, h, p, r, son_sunucu_saati_sn, localNow);
            return;
        }

        // 1d. GERİYE SARMA (Rewind): Sunucu zamanı geriye gitti
        //     Kayıt geriye sarıldı veya gecikmiş eski paket geldi → forceSync ile sıfırdan başla.
        if (son_sunucu_saati_sn < this.Son_Sunucu_Zamani) {
            console.log(`[MovementEngine] Geriye sarma tespit edildi: ${son_sunucu_saati_sn.toFixed(2)} < ${this.Son_Sunucu_Zamani.toFixed(2)}`);
            this.forceSync(lon, lat, alt, yatay_Hiz, h, p, r, son_sunucu_saati_sn, localNow);
            return;
        }

        // 1e. AYNI KONUM: GPS çözünürlüğü veya uçak durmuş
        //     Hiçbir state GÜNCELLENMİYOR (ne zaman ne açı referansları).
        //     Bu sayede sonraki gerçek hareket paketinde dtPacket doğru kalır.
        //     
        //     Neden işlemiyoruz? Son_Gercek_Konum değişmeden paket işlenirse:
        //     → Hata = görsel_konum - aynı_konum = DEV hata (ekstrapolasyon mesafesi kadar)
        //     → Sönümleme bu hatayı eritirken ekstrapolasyon sıfırdan büyüyor
        //     → Eritme hızı > ekstrapolasyon büyüme hızı → uçak GERİ ÇEKİLİR = TİTREME!
        const test_pos = Cesium.Cartesian3.fromDegrees(lon, lat, alt, Cesium.Ellipsoid.WGS84, MovementEngine._sNewPosValid);
        if (test_pos.equals(this.Son_Gercek_Konum)) {
            return;
        }


        // ═══════════════════════════════════════════════════════════════
        //  ADIM 2: ZAMAN HESAPLAMALARI
        // ═══════════════════════════════════════════════════════════════

        // --- FİZİKSEL ZAMAN (dtPacket) ---
        // Sunucu saati farkı: İki paketin üretildiği anlar arasındaki gerçek fiziksel süre.
        // Hız ve dönüş oranı hesabında kullanılır (lag'dan bağımsız, doğru fizik).
        const previousServerTime = this.Son_Sunucu_Zamani;
        const dtPacket = son_sunucu_saati_sn - previousServerTime; // saniye (float)

        // --- YEREL ZAMAN (dtLocal) ---
        // Paketlerin istemciye gerçekte ne aralıkla geldiğini ölçer.
        // Zaman Çarpanı hesabı ve pause→resume tespiti (dtLocal > 3s) için kullanılır.
        let dtLocal = 0;
        if (this.Paket_Sayisi > 0) {
            dtLocal = (localNow - this.Son_Paket_Yerel_Zamanı) / 1000.0;

            // OPS: SUNUCU zamanındaki paket aralığı (oynatma hızından bağımsız)
            // dtPacket her zaman simülasyon zamanıdır, 1x/8x/0.5x fark etmez.
            const clampedDtServer = Math.max(0.05, Math.min(dtPacket, 2.0));
            this.Ortalama_Paket_Suresi = this.Ortalama_Paket_Suresi * 0.8 + clampedDtServer * 0.2;

            // ZAMAN ÇARPANI: Simülasyon zamanı / Gerçek zaman
            // dtPacket = 0.2s (sunucu), dtLocal = 0.025s (8x hız) → çarpan = 8.0
            // dtPacket = 0.2s (sunucu), dtLocal = 0.4s (0.5x hız) → çarpan = 0.5
            // 0.005 = "paketler arasında en az 5ms geçmeli"
            if (dtLocal > 0.005) {
                const rawRatio = dtPacket / dtLocal;
                // 0.1 ve 32.0 = "simülasyon çarpanı en fazla 0.1 ile 32 arasında olmalı"
                const clampedRatio = Math.max(0.1, Math.min(rawRatio, 32.0));
                // İlk paketlerde direkt set et (EMA yakınsamasını bekleme)
                if (this.Paket_Sayisi <= 2) {
                    this.Zaman_Carpani = clampedRatio;
                } else {
                    // Yaklaşık 5 pakette yeni değere yakınsar.
                    this.Zaman_Carpani = this.Zaman_Carpani * 0.8 + clampedRatio * 0.2;
                }
            }
        }

        // Zamanları güncelle (buradan sonra render döngüsü yeni değerleri kullanır)
        this.Son_Sunucu_Zamani = son_sunucu_saati_sn;
        this.Son_Paket_Yerel_Zamanı = localNow;


        // ═══════════════════════════════════════════════════════════════
        //  ADIM 3: TIMEOUT / UZUN BOŞLUK KONTROLÜ
        // ═══════════════════════════════════════════════════════════════

        // İki koşuldan BİRİ sağlanırsa forceSync:
        //
        // dtPacket > 3s: Sunucu saati 3 saniyeden fazla ilerlemiş → ağ kopmuş
        //                (Sunucu ve istemci zamanı paralel ilerdiğinde çalışır)
        //
        // dtLocal > 3s:  Yerel kronometre 3 saniyeden fazla ilerlemiş → pause→resume
        //                (Simülasyon duraklatılıp devam ettiğinde sunucu saati küçük
        //                 adım atar ama yerel süre uzundur. Offset olmadığı için
        //                 bu kontrolü EKLEMEMİZ GEREKLİ — orijinal kodda gerekmiyordu
        //                 çünkü sunucu epoch bazlı zaman gönderiyordu.)
        if (dtPacket > this.MAKS_TAHMIN_SURESI || dtLocal > this.MAKS_TAHMIN_SURESI) {
            console.log(`[MovementEngine] Timeout → ForceSync. dtPacket=${dtPacket.toFixed(1)}s, dtLocal=${dtLocal.toFixed(1)}s`);
            this.forceSync(lon, lat, alt, yatay_Hiz, h, p, r, son_sunucu_saati_sn, localNow);
            return;
        }

        // 3 saniyeden uzun süredir gelmiyorsa dönüşleri ve dalışları sıfırla,
        // uçağı sadece ileriye doğru DÜMDÜZ uçur
        if (dtPacket > this.HAFIZA_TEMIZLEME_SURESI && previousServerTime > 0) {
            console.log(`[MovementEngine] ${dtPacket.toFixed(1)}s boşluk → Tahmin verileri sıfırlanıyor.`);
            this.Pruva_Donus_Hizi = 0;
            this.Rota_Donus_Hizi = 0;
            this.Yunuslama_Hizi = 0;
            this.Yatis_Hizi = 0;
            this.Dikey_Hiz = 0;
            this.Paket_Sayisi = 1; // sonraki pakette normal hesaplama başlamasını sağlar
        }


        // ═══════════════════════════════════════════════════════════════
        //  ADIM 4: FİZİK VE DÖNÜŞ HIZI HESAPLAMALARI
        //  (Orijinal kodla BİREBİR AYNI — değişiklik yok)
        // ═══════════════════════════════════════════════════════════════

        // 1. Yeni Konum (ECEF formatında)
        this.Paket_Sayisi++;
        const newPos = Cesium.Cartesian3.fromDegrees(lon, lat, alt, Cesium.Ellipsoid.WGS84, MovementEngine._sNewPos);

        // ONCE FİZİK VE DÖNÜŞ HIZI HESAPLAMALARI
        // trackTurnRate + turnRate + Speed hesapla
        if (dtPacket > 0.01 && previousServerTime > 0) {

            // İki paket arasındaki yer değiştirme vektörü (ECEF)
            const diff = Cesium.Cartesian3.subtract(newPos, this.Son_Gercek_Konum, MovementEngine._sTrackDiff);
            // Bu vektörü ENU (Local) düzlemine çevirelim ki açıyı bulalım
            Cesium.Transforms.eastNorthUpToFixedFrame(this.Son_Gercek_Konum, Cesium.Ellipsoid.WGS84, MovementEngine._sEnuMatrix);
            const invEnu = Cesium.Matrix4.inverse(MovementEngine._sEnuMatrix, MovementEngine._sInvEnuMatrix);
            const localDiff = Cesium.Matrix4.multiplyByPointAsVector(invEnu, diff, MovementEngine._sTrackEnu);

            // --- trackTurnRate hesabı ---
            const moveDist = Math.hypot(localDiff.x, localDiff.y); // z (yukarı) yı yok sayar
            let rawTrackTurnRate = 0;

            // 1. DURMA KONTROLÜ
            if (this.Yatay_Hiz < 2.0) { // 2.0 m/s = ~4knot
                // Araç duruyor veya park ediyor. Dönüş hızı kesinlikle SIFIR olmalı.
                rawTrackTurnRate = 0;
                this.Rota_Acisi = h;
            }
            // 2. GÜRÜLTÜ / BURST KONTROLÜ
            else if (moveDist < 1.5) {
                // Araç hızlı gidiyor ama 1.5 metreden az yol almış. Burst gelmiş.
                // Açı hesaplamak için mesafe çok kısa (gürültülü olur), ESKİ KAVİSİ KORU
                rawTrackTurnRate = this.Rota_Donus_Hizi;
            }
            // 3. NORMAL
            else {
                // Mesafe yeterince uzun, gerçek ve pürüzsüz açıyı hesapla
                this.Rota_Acisi = Math.atan2(localDiff.x, localDiff.y);

                // 3. paketten önce dönüş hızı (kavis) HESAPLANAMAZ
                if (this.Paket_Sayisi > 2) {
                    let deltaT = this.Rota_Acisi - this.Son_Rota_Acisi;
                    if (deltaT > Math.PI) deltaT -= Math.PI * 2;
                    if (deltaT < -Math.PI) deltaT += Math.PI * 2;
                    rawTrackTurnRate = deltaT / dtPacket;
                }
            }

            // İrtifa farkını geçen süreye bölüyoruz
            let rawDikeyHiz = (alt - this.Son_Irtifa) / dtPacket;

            // --- turnRate hesabı ---
            let rawTurnRate = 0;
            let rawPitchRate = 0;
            let rawRollRate = 0;

            if (this.Paket_Sayisi > 2) {
                // Güvenli Payda: Sensör çıldırsa bile ağın ortalama hızına güvenerek patlamayı önle
                const safeDt = Math.max(dtPacket, this.Ortalama_Paket_Suresi * 0.5);

                // YAW (Heading) Hızı
                let deltaH = h - this.Son_Pruva_Acisi;
                if (deltaH > Math.PI) deltaH -= Math.PI * 2;
                if (deltaH < -Math.PI) deltaH += Math.PI * 2;
                // deltaH yarım dereceden (0.5 derece = 0.0087 radyan) az ise bunu gerçek dönüş kabul etme
                if (Math.abs(deltaH) < 0.008) deltaH = 0;
                rawTurnRate = deltaH / safeDt;

                // PITCH (Yunuslama) Hızı
                let deltaP = p - this.Yunuslama_Acisi;
                if (deltaP > Math.PI) deltaP -= Math.PI * 2;
                if (deltaP < -Math.PI) deltaP += Math.PI * 2;
                if (Math.abs(deltaP) < 0.008) deltaP = 0;
                rawPitchRate = deltaP / safeDt;

                // ROLL (Yatış) Hızı
                let deltaR = r - this.Yatis_Acisi;
                if (deltaR > Math.PI) deltaR -= Math.PI * 2;
                if (deltaR < -Math.PI) deltaR += Math.PI * 2;
                if (Math.abs(deltaR) < 0.008) deltaR = 0;
                rawRollRate = deltaR / safeDt;
            }

            // --- LOW-PASS FILTER (Hareketli Ortalama) ---
            // Eğer uçak yeni doğduysa veya uzun süredir veri gelmiyorsa filtreyi sıfırla
            if (this.Paket_Sayisi <= 3 || dtPacket > this.HAFIZA_TEMIZLEME_SURESI) {
                this.Rota_Donus_Hizi = rawTrackTurnRate;
                this.Pruva_Donus_Hizi = rawTurnRate;
                this.Yunuslama_Hizi = rawPitchRate;
                this.Yatis_Hizi = rawRollRate;
                this.Dikey_Hiz = rawDikeyHiz;
            } else {
                // Ağdaki anlık kopmalara/patlamalara karşı eski istikrarı %80 koru, yeni hıza %20 güven
                this.Rota_Donus_Hizi = (this.Rota_Donus_Hizi * 0.8) + (rawTrackTurnRate * 0.2);
                this.Pruva_Donus_Hizi = (this.Pruva_Donus_Hizi * 0.8) + (rawTurnRate * 0.2);
                this.Yunuslama_Hizi = (this.Yunuslama_Hizi * 0.8) + (rawPitchRate * 0.2);
                this.Yatis_Hizi = (this.Yatis_Hizi * 0.8) + (rawRollRate * 0.2);
                this.Dikey_Hiz = (this.Dikey_Hiz * 0.8) + (rawDikeyHiz * 0.2);
            }
        }


        // ═══════════════════════════════════════════════════════════════
        //  ADIM 5: HATA VEKTÖRÜNÜ YAKALA
        //  (Orijinal kodla BİREBİR AYNI — değişiklik yok)
        // ═══════════════════════════════════════════════════════════════

        MovementEngine._sHpr.heading = h;
        MovementEngine._sHpr.pitch = p;
        MovementEngine._sHpr.roll = r;
        const newQuat = Cesium.Transforms.headingPitchRollQuaternion(newPos, MovementEngine._sHpr, Cesium.Ellipsoid.WGS84, Cesium.Transforms.eastNorthUpToFixedFrame, MovementEngine._sNewQuat);

        // BAŞLANGIÇ KANCASINI (HOOK) ÖNLE VE HATA VEKTÖRÜNÜ YAKALA
        if (this.Paket_Sayisi <= 2) {
            // İlk 2 pakette yumuşatmayı iptal et, doğrudan ham veriye ışınla (Kancayı engeller)
            Cesium.Cartesian3.ZERO.clone(this.Konum_Hatasi);
            Cesium.Quaternion.IDENTITY.clone(this.Yonelim_Hatasi);
            Cesium.Cartesian3.clone(newPos, this.Guncel_Gorsel_Konum);
            Cesium.Quaternion.clone(newQuat, this.Guncel_Gorsel_Yonelim);
        } else {

            // 3. Paketten itibaren hata sönümlemesine (Error Blending) başla
            // HATA VEKTÖRÜNÜ YAKALA
            // Yeni hedef konumu belirlemeden önce, görsel modelin ne kadar "yanlış" yerde kaldığını buluruz.
            Cesium.Cartesian3.subtract(this.Guncel_Gorsel_Konum, newPos, this.Konum_Hatasi);

            // Açı hatasını bul: oriError = currentVisual * inverse(newQuat)
            const invNewQuat = Cesium.Quaternion.inverse(newQuat, MovementEngine._sInvNewQuat);
            Cesium.Quaternion.multiply(this.Guncel_Gorsel_Yonelim, invNewQuat, this.Yonelim_Hatasi);

            // Güvenlik: Eğer ağda devasa bir lag olduysa ve hata 500 metreyi geçtiyse,
            // sönümleme yapma, direkt ışınlan (lastik gibi çekilmesini önler).
            if (Cesium.Cartesian3.magnitude(this.Konum_Hatasi) > 500.0) {
                Cesium.Cartesian3.ZERO.clone(this.Konum_Hatasi);
                Cesium.Cartesian3.clone(newPos, this.Guncel_Gorsel_Konum);
            }

            const nokta_carpim = Cesium.Quaternion.dot(this.Guncel_Gorsel_Yonelim, newQuat);
            const aci_farki_radyan = 2.0 * Math.acos(Math.min(Math.abs(nokta_carpim), 1.0));

            // Güvenlik: Eğer yönelim hatası 45 dereceden (~0.785 radyan) büyükse sönümleme yapma, doğrudan eşitle.
            const MAKS_ACI_SAPMASI_RADYAN = Cesium.Math.toRadians(45.0); // 45 derece radyan karşılığı
            if (aci_farki_radyan > MAKS_ACI_SAPMASI_RADYAN) {
                Cesium.Quaternion.IDENTITY.clone(this.Yonelim_Hatasi);
                Cesium.Quaternion.clone(newQuat, this.Guncel_Gorsel_Yonelim);
            }
        }

        this.Son_Rota_Acisi = this.Rota_Acisi;
        this.Son_Irtifa = alt;
        this.Son_Pruva_Acisi = h;
        this.Yunuslama_Acisi = p;
        this.Yatis_Acisi = r;
        this.Yatay_Hiz = yatay_Hiz; // Yatay hız doğrudan sunucudan geliyor

        // Gelecek döngü için temel dayanak noktasını kaydet
        Cesium.Cartesian3.clone(newPos, this.Son_Gercek_Konum);
    }


    /**
     * Her render frame'inde çağrılır.
     * 
     * TEK SAAT MİMARİSİ:
     * Hem ekstrapolasyon hem sönümleme aynı dt'yi kullanır:
     *   dt = (performance.now() - Son_Paket_Yerel_Zamanı) / 1000
     * 
     * Bu dt:
     * - Paket geldiğinde 0'dan başlar (sönümleme katsayısı = 1.0 → sıçrama yok)
     * - Monoton artar (performance.now() monoton)
     * - 3 saniye sonra timeout → görsel donar
     * 
     * Orijinal kodda iki farklı dt vardı (offset-bazlı ekstrapolasyon + yerel sönümleme).
     * Lag yokken ikisi pratikte aynıydı. Offset kaldırıldığı için artık tek dt yeterli.
     */
    public Guncel_Konumu_Getir(result: Cesium.Cartesian3): Cesium.Cartesian3 {

        if ((this.Son_Gercek_Konum.x === 0 && this.Son_Gercek_Konum.y === 0 && this.Son_Gercek_Konum.z === 0)
            || !Number.isFinite(this.Son_Gercek_Konum.x) || !Number.isFinite(this.Son_Gercek_Konum.y) || !Number.isFinite(this.Son_Gercek_Konum.z)) {
            return Cesium.Cartesian3.clone(this.Son_Gercek_Konum, this.Guncel_Gorsel_Konum);
        }

        const localNow = performance.now();

        // --- İKİ ZAMANLI dt MİMARİSİ ---
        // realDt : Gerçek zaman (performance.now bazlı) — sönümleme (görsel yumuşatma) için
        // simDt  : Simülasyon zamanı (realDt × Zaman_Carpani) — ekstrapolasyon (fizik tahmini) için
        //
        // 8x oynatmada realDt=0.025s iken simDt=0.2s olur → ekstrapolasyon doğru miktarda ilerler.
        // 0.5x oynatmada realDt=0.4s iken simDt=0.2s olur → fazla ilerleme engellenir.
        let realDt = (localNow - this.Son_Paket_Yerel_Zamanı) / 1000.0;
        if (realDt < 0) realDt = 0;

        // Simülasyon zamanına çevir (ekstrapolasyon için)
        const simDt = realDt * this.Zaman_Carpani;

        // Timeout: Simülasyon zamanında 3 saniyeden fazla veri yoksa → dondur
        if (simDt > this.MAKS_TAHMIN_SURESI) {
            return Cesium.Cartesian3.clone(this.Guncel_Gorsel_Konum, result);
        }

        // ═══════════════════════════════════════════════════════════════
        //  1. EKSTRAPOLASYON (Kusursuz Hayalet Hedefi Hesapla)
        //  simDt kullanılır — fizik hızları simülasyon zamanındadır.
        // ═══════════════════════════════════════════════════════════════

        const targetPos = Cesium.Cartesian3.clone(this.Son_Gercek_Konum, MovementEngine._sTargetPos);

        if (simDt > 0 && this.Yatay_Hiz > 1.0 && this.Paket_Sayisi >= 2) {

            const moveEnu = MovementEngine._sMoveEnu;

            // Eğer dönüş hızı çok küçükse (düz uçuş), sıfıra bölme hatasını önlemek için klasik doğrusal (kiriş) formül
            if (Math.abs(this.Rota_Donus_Hizi) < 0.001) {
                const predictedTrack = this.Rota_Acisi + (this.Rota_Donus_Hizi * simDt);
                moveEnu.x = Math.sin(predictedTrack) * this.Yatay_Hiz * simDt; // East
                moveEnu.y = Math.cos(predictedTrack) * this.Yatay_Hiz * simDt; // North
            }
            // Eğer uçak virajdaysa YAY İNTEGRALİ (CTRV - Sabit Dönüş Hızı ve Hız Modeli)
            else {
                const theta0 = this.Rota_Acisi;
                const theta1 = theta0 + (this.Rota_Donus_Hizi * simDt);
                const R = this.Yatay_Hiz / this.Rota_Donus_Hizi; // Dönüş Yarıçapı (V / w)

                // Vx=Sin integrali -Cos. Vy=Cos integrali Sin.
                moveEnu.x = R * (Math.cos(theta0) - Math.cos(theta1)); // East
                moveEnu.y = R * (Math.sin(theta1) - Math.sin(theta0)); // North
            }

            // DİKEY TAHMİN
            moveEnu.z = this.Dikey_Hiz * simDt;

            // ENU → ECEF dönüşüm matrisi
            Cesium.Transforms.eastNorthUpToFixedFrame(this.Son_Gercek_Konum, Cesium.Ellipsoid.WGS84, MovementEngine._sEnuMatrix);
            Cesium.Matrix4.multiplyByPointAsVector(MovementEngine._sEnuMatrix, moveEnu, MovementEngine._sMoveEcef);
            Cesium.Cartesian3.add(targetPos, MovementEngine._sMoveEcef, targetPos);
        }

        // ═══════════════════════════════════════════════════════════════
        //  2. HATA VEKTÖRÜNÜ ERİT (ERROR BLENDING) — ÇÖZÜM A İLE
        // ═══════════════════════════════════════════════════════════════
        //
        // Sönümleme realDt kullanır (görsel yumuşatma gerçek zamanda olmalı).
        // normalRate, Ortalama_Paket_Suresi (sunucu zamanı) ile hesaplanır.
        // maxRate, görsel hızı (Yatay_Hiz × Zaman_Carpani) kullanır:
        //   Ekran üzerindeki hız = sim_hız × oynatma_çarpanı
        //   Geri çekilmeme garantisi bu görsel hıza göre yapılır.

        const pozisyon_hatasi_buyukluk = Cesium.Cartesian3.magnitude(this.Konum_Hatasi);
        let sonumleme_carpani = 3.0;
        if (this.Yatay_Hiz < 5.0) {
            if (pozisyon_hatasi_buyukluk < 0.5) {
                sonumleme_carpani = 0.5; // ilerleme ve hız az ise hatayı daha yavaş erit
            } else {
                sonumleme_carpani = 1.0;
            }
        }

        const safeBlendDuration = this.Ortalama_Paket_Suresi;
        const normalRate = sonumleme_carpani / safeBlendDuration;

        // ÇÖZÜM A: Geri çekilme önleyici — görsel hız ile sınırla
        // Ekrandaki görsel hız = sim_hız × oynatma_çarpanı
        const gorsel_hiz = this.Yatay_Hiz * this.Zaman_Carpani;
        const maxRate = gorsel_hiz / Math.max(pozisyon_hatasi_buyukluk, 0.01);

        // Minimum erime hızı: duran araçta bile hata erisin (hız=0 → maxRate=0 olur)
        const Sonumleme_Hizi = Math.max(0.5, Math.min(normalRate, maxRate));

        // Sönümleme realDt ile — gerçek zamanda görsel yumuşatma
        let Sonumleme_Katsayisi = Math.exp(-Sonumleme_Hizi * realDt);
        // Paketler arası süre çok azsa bile biraz sönümle ki titremesin
        if (Sonumleme_Katsayisi > 0.99) Sonumleme_Katsayisi = 0.99;

        // 3. Görsel Konum = Kusursuz Konum + Eriyen Hata
        const currentError = Cesium.Cartesian3.multiplyByScalar(this.Konum_Hatasi, Sonumleme_Katsayisi, MovementEngine._sMoveEcef);
        Cesium.Cartesian3.add(targetPos, currentError, this.Guncel_Gorsel_Konum);

        return Cesium.Cartesian3.clone(this.Guncel_Gorsel_Konum, result);
    }

    // HEADING + ROLL + PITCH EKSTRAPOLASYONU
    public Guncel_Yonelimi_Getir(result: Cesium.Quaternion): Cesium.Quaternion {

        if (!Number.isFinite(this.Guncel_Gorsel_Konum.x) || !Number.isFinite(this.Guncel_Gorsel_Konum.y) || !Number.isFinite(this.Guncel_Gorsel_Konum.z)) {
            return Cesium.Quaternion.clone(this.Guncel_Gorsel_Yonelim, result);
        }

        const localNow = performance.now();

        // --- İKİ ZAMANLI dt MİMARİSİ (konum ile aynı mantık) ---
        let realDt = (localNow - this.Son_Paket_Yerel_Zamanı) / 1000.0;
        if (realDt < 0) realDt = 0;
        const simDt = realDt * this.Zaman_Carpani;

        if (simDt > this.MAKS_TAHMIN_SURESI) {
            // Simülasyon zamanında 3s → yönelimi dondur
            return Cesium.Quaternion.clone(this.Guncel_Gorsel_Yonelim, result);
        }

        // Heading'i turnRate ile tahmin et (simDt — simülasyon zamanı)
        const predictedHeading = this.Son_Pruva_Acisi + (this.Pruva_Donus_Hizi * simDt);
        const predictedPitch = this.Yunuslama_Acisi + (this.Yunuslama_Hizi * simDt);
        const predictedRoll = this.Yatis_Acisi + (this.Yatis_Hizi * simDt);

        MovementEngine._sHpr.heading = predictedHeading;
        MovementEngine._sHpr.pitch = predictedPitch;
        MovementEngine._sHpr.roll = predictedRoll;

        // Modelin ekrandaki konumunda ENU çerçevesinden quaternion hesapla
        const predictedQuat = Cesium.Transforms.headingPitchRollQuaternion(
            this.Guncel_Gorsel_Konum, MovementEngine._sHpr,
            Cesium.Ellipsoid.WGS84, Cesium.Transforms.eastNorthUpToFixedFrame,
            MovementEngine._sNewQuat
        );

        // HATA VEKTÖRÜNÜ ERİT (ERROR BLENDING) — ÇÖZÜM A İLE
        // Sönümleme realDt kullanır, maxRate görsel açısal hız ile
        //
        // Açısal hata büyüklüğünü quaternion dot product ile hesapla (radyan cinsinden)
        // Yonelim_Hatasi, IDENTITY'ye yakınsa hata küçük, uzaksa büyük.
        const ori_dot = Cesium.Quaternion.dot(Cesium.Quaternion.IDENTITY, this.Yonelim_Hatasi);
        const acısal_hata_radyan = 2.0 * Math.acos(Math.min(Math.abs(ori_dot), 1.0));

        let sonumleme_carpani = 3.0;
        if (this.Yatay_Hiz < 5.0) {
            if (acısal_hata_radyan < 0.05) { // ~3° altında
                sonumleme_carpani = 0.5;
            } else {
                sonumleme_carpani = 1.0;
            }
        }
        const safeBlendDuration = Math.max(this.Ortalama_Paket_Suresi, 0.2);
        const normalRate_ori = sonumleme_carpani / safeBlendDuration;

        // ÇÖZÜM A (Yönelim): Ters dönüş önleyici — görsel açısal hız ile sınırla
        const acisal_hiz = Math.max(
            Math.abs(this.Pruva_Donus_Hizi),
            Math.abs(this.Yunuslama_Hizi),
            Math.abs(this.Yatis_Hizi)
        );
        // Görsel açısal hız = sim açısal hız × oynatma çarpanı
        const gorsel_acisal_hiz = acisal_hiz * this.Zaman_Carpani;
        const maxRate_ori = gorsel_acisal_hiz / Math.max(acısal_hata_radyan, 0.001);

        // Minimum 0.5: duran/düz uçan araçta bile açısal hata yavaşça erisin
        const Sonumleme_Hizi = Math.max(0.5, Math.min(normalRate_ori, maxRate_ori));

        // Sönümleme realDt ile — gerçek zamanda görsel yumuşatma
        let Sonumleme_Katsayisi = Math.exp(-Sonumleme_Hizi * realDt);
        // Paketler arası süre çok azsa bile biraz sönümle ki titremesin
        if (Sonumleme_Katsayisi > 0.99) Sonumleme_Katsayisi = 0.99;

        // Açı hatasını sıfıra (IDENTITY) doğru küçült
        // slerp: İki yön arasındaki en kısa yolu izleyen küresel yumuşatma fonksiyonudur.
        const decayedOriError = Cesium.Quaternion.slerp(Cesium.Quaternion.IDENTITY, this.Yonelim_Hatasi, Sonumleme_Katsayisi, MovementEngine._sDecayedOriError);

        // Görsel Yönelim = Eriyen Hata * Kusursuz Yönelim
        Cesium.Quaternion.multiply(decayedOriError, predictedQuat, this.Guncel_Gorsel_Yonelim);

        return Cesium.Quaternion.clone(this.Guncel_Gorsel_Yonelim, result);
    }


    /**
     * Uçağı anında yeni bir konuma ve yöne ışınlar.
     * Tüm tahmin verileri, hata vektörleri ve zamanları sıfırlar.
     *
     * @param serverTime - Paketin sunucu saati (sn, float). Son_Sunucu_Zamani'nı set eder.
     * @param localNow   - Paketin geldiği yerel an (performance.now() ms). Son_Paket_Yerel_Zamanı'nı set eder.
     *
     * Zamanlar forceSync İÇİNDE set edilir (dışarıda set etmeye gerek yok).
     * Bu tutarlılığı garanti eder: forceSync çağrılan HER yerde zamanlar doğrudur.
     */
    private forceSync(lon: number, lat: number, alt: number, speed: number, h: number, p: number, r: number,
        serverTime: number, localNow: number) {
        // 1. Konum ve görsel durumu hedefe ışınla
        const posEcef = Cesium.Cartesian3.fromDegrees(lon, lat, alt, Cesium.Ellipsoid.WGS84, MovementEngine._sNewPos);

        Cesium.Cartesian3.clone(posEcef, this.Son_Gercek_Konum);
        Cesium.Cartesian3.clone(posEcef, this.Guncel_Gorsel_Konum);

        const quat = this.calculateQuaternion(posEcef, h, p, r);
        Cesium.Quaternion.clone(quat, this.Guncel_Gorsel_Yonelim);

        // 2. TAHMİN MOTORUNU SIFIRLA
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
        this.Zaman_Carpani = 1.0; // Oynatma hızı oranını sıfırla

        // 3. ZAMANLARI SET ET
        // forceSync bir "sıfırdan başlama" operasyonudur. Zamanların burada
        // set edilmesi, çağıran tarafta unutulma riskini ortadan kaldırır.
        this.Son_Sunucu_Zamani = serverTime;
        this.Son_Paket_Yerel_Zamanı = localNow;

        // 4. Hata vektörlerini sıfırla (lastik çekilme efekti olmasın)
        Cesium.Cartesian3.ZERO.clone(this.Konum_Hatasi);
        Cesium.Quaternion.IDENTITY.clone(this.Yonelim_Hatasi);

        console.log(`[MovementEngine] Işınlanma (ForceSync) tamamlandı: ${lon.toFixed(5)}, ${lat.toFixed(5)}`);
    }

    /**
    * Belirli bir konum ve HPR açısı için Cesium Quaternion üretir.
    * Scratchpad kullanarak bellek yönetimini optimize eder.
    */
    private calculateQuaternion(position: Cesium.Cartesian3, h: number, p: number, r: number): Cesium.Quaternion {
        const hpr = MovementEngine._sHpr;
        hpr.heading = h;
        hpr.pitch = p;
        hpr.roll = r;

        // Cesium'un yerel ENU (East-North-Up) çerçevesinden dünya çerçevesine dönüşüm
        return Cesium.Transforms.headingPitchRollQuaternion(
            position,
            hpr,
            Cesium.Ellipsoid.WGS84,
            Cesium.Transforms.eastNorthUpToFixedFrame,
            MovementEngine._sNewQuat // Mevcut scratchpad'i kullanıyoruz
        );
    }


}
