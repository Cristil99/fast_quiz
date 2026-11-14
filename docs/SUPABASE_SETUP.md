# Supabase 登入與筆記同步設定（v1）

本功能仍是無建置步驟的靜態網站。公開設定在
[js/supabase-config.js](../js/supabase-config.js)，使用官方 supabase-js
**2.119.0** 的固定 CDN URL；沒有 secret、service_role 或寫在程式內的登入密碼。

## 1. 執行 SQL

1. 在 Supabase 管理後台選擇專案 uktjkboavdqfkkwszbxu。
2. 開啟 SQL Editor，新增查詢，貼上
   [supabase/notes_schema.sql](../supabase/notes_schema.sql) **完整內容**後執行。
3. 必須看到執行成功。SQL 包含交易、資料表、觸發器、RPC、RLS 與明確 GRANT。
   Automatically expose new tables 可以維持關閉，不需為其他表開啟權限。
4. 在 Integrations / Data API（後台版本不同時名稱可能略異）確認 Data API 已啟用、
   public 在 exposed schemas；本功能只需要 public.quiz_notes 與 quiz_notes_write_v1。
5. SQL 可以安全重跑：不刪表、不清空筆記，只更新本功能具名的函式、觸發器及政策。
   如果已存在不同結構的同名表而執行失敗，停止並檢查差異，不能用 DROP TABLE 解決。

在 SQL Editor 執行以下查詢確認配置：

~~~sql
select relrowsecurity from pg_class
where oid = 'public.quiz_notes'::regclass; -- true

select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname='public' and tablename='quiz_notes';

select
 has_schema_privilege('authenticated', 'public', 'USAGE') as schema_ok,
 has_table_privilege('authenticated', 'public.quiz_notes', 'SELECT') as can_select,
 has_table_privilege('authenticated', 'public.quiz_notes', 'INSERT') as can_insert,
 has_table_privilege('authenticated', 'public.quiz_notes', 'UPDATE') as can_update,
 has_table_privilege('authenticated', 'public.quiz_notes', 'DELETE') as can_delete,
 has_table_privilege('anon', 'public.quiz_notes', 'SELECT') as anon_select;
-- true, true, true, true, false, false

select
 has_function_privilege('authenticated',
 'public.quiz_notes_write_v1(uuid,text,text,text,timestamptz,timestamptz,jsonb,bigint)',
 'EXECUTE') as app_rpc,
 has_function_privilege('anon',
 'public.quiz_notes_write_v1(uuid,text,text,text,timestamptz,timestamptz,jsonb,bigint)',
 'EXECUTE') as anon_rpc;
-- true, false
~~~

SQL Editor 使用管理角色，查得到資料不代表 RLS 已驗收。仍需依第 6 節測試 APP 帳號。

資料表完整保留 question_key、text note_id、內容、原時間與 metadata.note
（包含 importConflict、syncConflict 等原筆記欄位）。
索引為 user_id + 32-byte identity_hash：由完整 question_key、NUL 分隔符與 note_id
計算 SHA-256，避免長備援 questionKey 超過 PostgreSQL B-tree 索引大小。
RPC 遇到相同雜湊也會核對兩段完整原文；不截斷識別、不覆寫碰撞資料。

version 只由伺服器觸發器產生：新增為 1，每次更新遞增。
RPC 以 expected_version 條件更新；新增撞到原識別或版本已變時回傳 conflict。
函式全為 security invoker；RLS SELECT / INSERT / UPDATE 均限制 auth.uid()，
UPDATE 同時有 USING 與 WITH CHECK，RPC 另核對 p_user_id。
authenticated 有明確 SELECT、INSERT、UPDATE 和 RPC EXECUTE；沒有 DELETE。
anon / PUBLIC 不獲筆記表或 RPC 權限，不更動其他表或全域預設權限。

## 2. 建立 APP 帳號

在 Authentication → Users → Add user → Create new user 建立 Email 與密碼，
並勾選 Auto Confirm User / 已確認 Email。不要使用 Invite user 取代已確認帳號流程。
若介面沒有此選項，確認建立後的帳號已有 Email confirmed 狀態。

這是此專案 auth.users 內的 **APP 使用者**，不是你登入 Supabase 管理後台的管理帳號。
前端沒有自行註冊、寄驗證信或忘記密碼功能；帳號管理先在後台處理。
確認 Email provider 與 Email/password 登入已啟用。
密碼只由使用者在網頁輸入；不要貼到程式、SQL、Git、測試紀錄或聊天。

目前使用密碼登入，不依賴 OAuth 或 Email redirect。Site URL 可設為：
https://cristil99.github.io/fast_quiz/
日後若加入郵件驗證或 OAuth，才另配置對應 Redirect URLs。

## 3. CMD 啟動

視窗一：

~~~cmd
cd /d C:\Users\piiou\my_web\quiz_web\fast_quiz
..\venv\Scripts\python.exe -m http.server 8000 --bind 127.0.0.1
~~~

視窗二：

~~~cmd
start "" "http://127.0.0.1:8000/"
~~~

首次更新按 Ctrl+F5。停止伺服器按 Ctrl+C。
不需要 npm install、編譯或 .env；設定檔直接提供瀏覽器所需公開值。
所有本機 JS、題庫路徑相對於目前頁面，可在 GitHub Pages /fast_quiz/ 子路徑使用。

## 4. 保存範圍與遷移

- 未登入仍使用 fast_quiz.notes.v1，原資料不被自動上傳、清空或改寫成帳號資料。
- 每個帳號使用 fast_quiz.notes.account.v1.<user_id>。
  一筆 localStorage 寫入同時包含 data、versions、pending（待傳筆記與 mutationId），
  避免只存筆記卻遺失待同步狀態。
- 登入狀態由 SDK 保存在 fast_quiz.auth.v1；其中包含工作階段權杖，不包含密碼。
- 不同網址、連接埠、協定、瀏覽器設定檔各有自己的原本機資料與快取。
  127.0.0.1 和 localhost 也不同。登入同一 APP 帳號後才可透過雲端交換資料。
- 登出只結束此瀏覽器的工作階段，不讓另一台裝置一起登出。
  保留各帳號快取與待傳資料，但登出後介面及匯出只讀原未登入筆記。
- 帳號切換會中止舊工作，遲到回應不能寫入新帳號。
  草稿僅在此頁的原帳號記憶體中暫存，不能跨帳號顯示；一般同步不清除編輯器。
- 清除瀏覽器網站資料會移除該瀏覽器的筆記、快取與待傳資料。請先匯出備份，
  不要把只存本機、尚未同步的資料當作已有雲端備份。

兩端遷移步驟：

1. 在裝置 A 未登入時先匯出全部原筆記，備份留在下載資料夾，不加入 Git。
2. 登入 APP 帳號，確認畫面顯示該帳號與原本機筆記數量。
3. 明確按「將原本機筆記匯入目前帳號」。保留 ID、日期與衝突資訊；
   原未登入資料仍保留。再次遷移會按原識別及衝突內容去重。
4. 等待「已同步」。若是「已存本機，尚未同步」，先完成第 1 節或修復網路後重試。
5. 裝置 B 同樣先備份，登入 **同一 APP 帳號**，待雲端讀取後匯入 B 的原筆記。
6. A、B 按「立即同步」，確認兩邊筆記都存在，再匯出帳號資料備份。

登入後的 JSON 匯入只合併進目前帳號，會排入該帳號待同步佇列。
匯出也只包含目前帳號；未登入時只包含原本機資料，絕不混合不同帳號。

## 5. 同步及失敗處理

登入、立即同步、網路恢復、頁面重新可見會觸發同步；沒有使用 Realtime 訂閱。
需要看另一裝置剛完成的修改時，按立即同步或切回此頁。

每次保存先寫入帳號快取及持久待傳佇列；成功後才發出請求。
「已同步」只會在完整分頁讀取及待傳確認完成後出現。
失敗顯示「已存本機，尚未同步」，可重新整理、登入同帳號後重試。
未成功寫入 localStorage 時，不顯示保存成功，也不送出新筆記。

同步序列執行，使用 identity_hash 游標持續讀到空頁，
不以第一頁或短頁判斷資料已完整。更新帶上最後讀到的 version。
版本衝突或新增撞號先重新處理伺服器回傳版本；不同內容留下同步衝突副本。
副本 ID 由 questionKey、原 noteId 與內容的 SHA-256 確定產生，
相同衝突與遺失回應後的重試不會不斷新增副本。
副本保留原日期，顯示「同步衝突副本」；原匯入衝突標記仍保留。
編輯器也保留開啟時的版本與內容。若草稿期間收到遠端更新，保存草稿仍用原版本檢查，
不能因背景下載了較新的 version 就直接覆寫遠端修改。

同步期間再次保存，舊回應只能確認自己的 mutationId，不能清除新草稿或較新的待傳內容。
中途關閉仍保留 outbox；即使雲端已寫入但回應遺失，重試會先核對原識別及內容。
本版沒有筆記刪除同步與跨帳號資料搬移。

SDK 或 CDN 不可用時，原刷題、未登入本機筆記、匯出／匯入仍可使用。
如果離線重新整理而 SDK 沒有快取，帳號快取仍保留，恢復網路後重新整理再登入即可重試。
GitHub Pages 網站本身沒有新增離線 Service Worker；完全離線重新載入網站仍取決於瀏覽器快取，
使用本機 http.server 時請保持伺服器執行。
請使用 HTTPS GitHub Pages 或 localhost / 127.0.0.1；同步衝突雜湊需要安全來源的 Web Crypto。

## 6. 人工驗收（真實 Supabase）

請用兩份獨立瀏覽器設定檔或兩台裝置，並用後台建立的 APP 測試帳號。
不要清除目前真實筆記來製造測試環境。

1. 未登入：確認原筆記查看、新增、編輯、匯出及合併匯入正常。
2. A 登入測試帳號，遷移少量原筆記；重複遷移不可增加重複項目。
3. B 登入同帳號，立即同步，檢查 A 的內容、建立日期、更新日期及衝突標記。
4. A 新增、B 修改，各按同步，另一端立即同步後可讀到。
5. 兩端先同步同一則，兩端各改不同內容再同步，兩個版本皆須保留。
   重複同步不能持續產生相同衝突副本。
6. 斷開對 Supabase 的連線後保存，應顯示只存本機；重新整理後登入原帳號，
   恢復網路並重試，確認只傳一次且內容仍在。
7. 網路失敗或尚未建表時不得出現已同步。讓請求延遲時再保存一次，
   舊回應不能清除較新的待傳內容。
8. A 有進行中請求時登出、切換另一 APP 帳號；畫面、匯出、雲端資料不可混用。
   登出應回到原未登入資料。另一設定檔仍登入，不應一起被登出。
9. 以帳號 B 的 Network 請求改成帳號 A 的 user_id 查詢，必須看不到 A 的列。
   改 RPC 的 p_user_id 為 A 必須拒絕；直接 INSERT 別人 user_id 必須拒絕，
   UPDATE 別人的列不能改到任何資料。
   不帶 APP session、只帶 publishable key 的表查詢和寫入也必須拒絕。
   不要輸出、截圖或提交 access_token。SQL Editor 的管理角色查詢不能替代這項驗收。
10. 同步過程保留草稿、題號與分數；完成一輪後重刷，確認第一題後可進第二題。

## 7. 本次檢查的界線

程式和 SQL 交付不代表遠端專案已完成設定。
本次初始唯讀 API 回覆 PGRST205：schema cache 找不到 public.quiz_notes。
遠端建表、APP 帳號、真實兩裝置同步及真實 Supabase RLS 必須完成上節驗收。

暫存 PostgreSQL 引擎檢查使用模擬 auth.uid，驗證建表重跑、GRANT、RLS 與版本條件；
瀏覽器測試使用獨立資料及模擬 Auth / Data API。
這些結果不能當作真實 Supabase 雲端同步或遠端 RLS 已通過。

參考官方文件：
- [supabase-js 安裝](https://supabase.com/docs/reference/javascript/installing)
- [Email 密碼登入](https://supabase.com/docs/guides/auth/passwords)
- [Auth 事件](https://supabase.com/docs/reference/javascript/auth-onauthstatechange)
- [本機工作階段登出](https://supabase.com/docs/reference/javascript/auth-signout)
- [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Data API GRANT](https://supabase.com/docs/guides/api/securing-your-api)
