# QuizBuzz — Real-time multiplayer quiz

## Lokaal starten

```bash
npm install
npm start
# of voor development (auto-restart):
npm run dev
```

Open dan: http://localhost:3000

## Structuur

```
quizbuzz/
├── server.js          # Node.js + Socket.io backend
├── package.json
└── public/
    └── index.html     # Frontend (host + speler in één pagina)
```

## Hoe het werkt

1. **Host** opent de app → vragen instellen → "Lobby aanmaken" → krijgt een 4-cijferige join-code
2. **Spelers** openen dezelfde URL → voeren join-code + naam in → wachten in lobby
3. **Host** start de quiz → vragen verschijnen real-time op alle schermen
4. **Spelers** klikken op een antwoord → hoe sneller, hoe meer punten
5. Na elke vraag ziet iedereen het scorebord

## Deployen op een server (VPS)

### Vereisten
- Node.js 18+ 
- Een server met open poort (standaard 3000, of stel PORT in als env variable)

### Stappen

```bash
# 1. Zet bestanden op de server (bijv. via scp of git clone)
scp -r quizbuzz/ user@jouw-server:/var/www/quizbuzz

# 2. Op de server:
cd /var/www/quizbuzz
npm install --production

# 3. Start met PM2 (zodat het blijft draaien na reboot)
npm install -g pm2
pm2 start server.js --name quizbuzz
pm2 save
pm2 startup
```

### Nginx reverse proxy (aanbevolen)

Zet in `/etc/nginx/sites-available/quizbuzz`:

```nginx
server {
    listen 80;
    server_name jouwdomein.nl;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Activeer en herstart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/quizbuzz /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### HTTPS (gratis via Let's Encrypt)
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d jouwdomein.nl
```

## Deployen op Railway.app (makkelijkst)

1. Push code naar GitHub
2. Ga naar railway.app → "New Project" → "Deploy from GitHub"
3. Selecteer je repo — Railway detecteert Node.js automatisch
4. Klaar! Je krijgt een gratis URL (bijv. `quizbuzz.railway.app`)

## Omgevingsvariabelen

| Variabele | Standaard | Beschrijving |
|-----------|-----------|--------------|
| PORT      | 3000      | Poort waarop de server luistert |
