# Dormant Candidates

Finds dormant candidates in Loxo, stores them in a Google Sheet, and sends them a WhatsApp template through respond.io.

## Flow (one run)

1. All jobs (`/jobs`, paged), keeping each job's city.
2. Per job: candidates in stage 11941, minus anyone with any event on that job in the last 30 days = **dormant**.
3. **All dormant candidates** (Candidate Id, Person Id, Name) replace the contents of the Google Sheet tab.
4. For messaging, keep only people with a phone in `+<digits>` form and a name. City = the person's city, or the job's city if the person has none. Skip anyone in the sent log, and dedupe by person and by phone.
5. need_message (all events of the person, across all jobs): at least one trigger event, the latest one 30+ days old, and no block or stop event. Skipped on any fetch error or incomplete history.
6. Cap at `MAX_PER_RUN` and send one at a time, with `DELAY_BETWEEN_MESSAGES_SEC` between messages:
   - `GET /contact/phone:+…`: if the contact already has the `outreach` tag, skip it,
   - `POST /contact/create_or_update/phone:+…` with first name and the `loxo_candidate_id`, `loxo_job_id` and `loxo_person_id` custom fields,
   - wait `CONTACT_DELAY_SEC`,
   - `POST /contact/phone:+…/tag` with `["outreach"]`,
   - `POST /contact/phone:+…/message` with template `ateca_cold_approach_mapped_v1` (en) on channel `RESPOND_CHANNEL_ID`, where {{1}} = name, {{2}} = "Steve" and {{3}} = city.

   The message send is never retried on 5xx, so nobody can get it twice.
7. After a successful send, log a "Sent Text Message" (100547) event in Loxo. That type is a stop type, so the person is never picked again. If logging fails 3 times, the person id goes into the sent log (`SENT_LOG_FILE`) and is skipped on future runs.

### Never messaging anyone twice

- **respond.io tag (main guard):** the `outreach` tag is added *before* the message is sent, and any phone that already has it is skipped. A crash or timeout after sending can't lead to a second message. The trade-off: if a send fails after tagging, that phone isn't retried. Remove the tag in respond.io to retry it.
- **Loxo:** the "Sent Text Message" (100547) event stops the person being selected again.
- **Sent log:** a backup used when the Loxo log fails.
- **Within a run:** one message per person and per phone number.
- The message send itself is never retried after a server error.

`DRY_RUN=true` (the default) only prints what would be sent. Set `DRY_RUN=false` to send.

## Local run

```
npm install
copy .env.example .env   # fill in values
npm start                # one run, then exit
npm run schedule         # stays running, 09:00 Asia/Dubai daily
```

## Cloud Run (Job + Cloud Scheduler)

Store the secrets once (Secret Manager):

```
gcloud secrets create loxo-token --data-file=-          # paste the token, then Ctrl+Z / Ctrl+D
gcloud secrets create respond-token --data-file=-
gcloud secrets create google-sa-key --data-file=service-account.json
gcloud storage buckets create gs://<BUCKET> --location=<REGION>   # keeps the sent log between runs
```

Deploy the job (built from the Dockerfile):

```
gcloud run jobs deploy dormant-candidates --source . --region <REGION> \
  --task-timeout 3600 --max-retries 0 \
  --set-env-vars DRY_RUN=false,LOXO_SLUG=ateca-consulting,RESPOND_CHANNEL_ID=525893,MAX_PER_RUN=50,DELAY_BETWEEN_MESSAGES_SEC=10,CONTACT_DELAY_SEC=3,GOOGLE_SHEET_ID=<SHEET_ID>,GOOGLE_SHEET_TAB=Sheet1,GOOGLE_SERVICE_ACCOUNT_FILE=/secrets/google/service-account.json,SENT_LOG_FILE=/state/sent.json \
  --set-secrets LOXO_TOKEN=loxo-token:latest,RESPOND_API_TOKEN=respond-token:latest,/secrets/google/service-account.json=google-sa-key:latest \
  --add-volume name=state,type=cloud-storage,bucket=<BUCKET> --add-volume-mount volume=state,mount-path=/state
```

`--max-retries 0` matters: a failed run must not be retried automatically.

Schedule it daily at 09:00 UAE:

```
gcloud scheduler jobs create http dormant-candidates-daily --location <REGION> \
  --schedule "0 9 * * *" --time-zone "Asia/Dubai" --http-method POST \
  --uri "https://run.googleapis.com/v2/projects/<PROJECT_ID>/locations/<REGION>/jobs/dormant-candidates:run" \
  --oauth-service-account-email <INVOKER_SA>@<PROJECT_ID>.iam.gserviceaccount.com
```

The invoker service account needs the `roles/run.invoker` role. The job's runtime service account needs `roles/secretmanager.secretAccessor` and write access to the bucket.
