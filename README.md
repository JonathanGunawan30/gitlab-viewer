# GitLab MR Diff Viewer (CLI)

> **Ultra-lightweight private GitLab Merge Request diff viewer** dengan highlight super jelas, zero server overhead, dan 100% aman di lokal.

---

## ⚡ Fitur Utama

- **Highlight Super Jelas & Detail**:
  - Word-level & Character-level diff highlight (perubahan kata langsung kelihatan kontras).
  - Syntax highlighting otomatis sesuai bahasa pemrograman (TypeScript, JavaScript, Go, Python, Java, PHP, dll).
  - High-contrast Dark Mode (default) & Light Mode dengan 1-click toggle.
  - Side-by-Side (Split) & Line-by-Line (Unified) toggle instan tanpa reload.
- **Zero Server Overhead & 0 RAM di Background**:
  - Tidak ada server Express / port yang tertinggal.
  - CLI selesai dalam 1-2 detik, browser otomatis terbuka, dan proses terminal langsung exit (`process.exit(0)`).
- **Zero Sampah di Disk**:
  - Menggunakan 1 file sementara di folder `%TEMP%` yang otomatis ditimpa setiap kali Anda membuka MR baru.
- **Aman & Terisolasi di Lokal**:
  - Dikunci dengan `"private": true` sehingga tidak bisa ter-publish ke npm publik.
  - Token tidak pernah dikirim ke browser / internet publik, hanya dipakai untuk memanggil GitLab API v4 secara langsung.
- **File Explorer & Review Productivity**:
  - Filter / Search file berdasarkan nama atau ekstensi (`.ts`, `auth`, dll).
  - Checkbox *"Mark as Reviewed"* dengan status progress bar.
  - Tombol *Collapse / Expand* dan *Copy File Path* di setiap header file.
  - Tab *Overview* (MR description Markdown) dan tab *Discussions* (komentar review).

---

## 🚀 Cara Penggunaan

### 1. Simpan Token Anda (Cukup 1x Saja)

Masukkan Personal Access Token (PAT) akun sharing Anda:
```bash
mr-view config set-token glpat-xxxxxxxxxxxxxxxxxxxx
```
*(Token disimpan aman di file lokal `~/.gitlab-viewer/config.json`)*.

Untuk mengecek status konfigurasi:
```bash
mr-view config show
```

---

### 2. Buka Merge Request

Cukup jalankan command dengan menyertakan link MR GitLab:
```bash
mr-view https://gitlab.com/nama-group/nama-repo/-/merge_requests/42
```
Atau gunakan alias panjang:
```bash
gitlab-viewer https://gitlab.com/nama-group/nama-repo/-/merge_requests/42
```

Mendukung juga GitLab Self-Hosted / Enterprise:
```bash
mr-view https://gitlab.company.domain/backend/core-service/-/merge_requests/15
```

---

## ⚙️ Opsi Tambahan

```bash
# Menimpa token sementara untuk 1 kali eksekusi
mr-view https://gitlab.com/... -t glpat-other-token

# Simpan diff ke file HTML tertentu (bukan temp)
mr-view https://gitlab.com/... -o ./review-mr-42.html

# Hanya generate file tanpa otomatis membuka browser
mr-view https://gitlab.com/... --no-open
```

---

## 🔒 Privasi & Keamanan

- **Scope Token yang Dibutuhkan**: Minimal `read_api` (atau `api`) dan `read_repository`.
- **Package Private**: `"private": true` diaktifkan di `package.json` untuk mencegah publish ke registry publik.
- **Offline Assets**: Semua styling dan library diff di-bundle langsung, sehingga viewer tidak melakukan panggilan ke CDN luar.
