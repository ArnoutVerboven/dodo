# infra/terraform

The GCP side of dodo: APIs, service accounts and IAM, the lifetime budget and its Pub/Sub
topic, Artifact Registry, the worker Cloud Run Job and its API key, and the Workload Identity
pool GitHub Actions signs in through. Firebase (Hosting, Functions, rules, indexes) still
deploys through the Firebase CLI in `.github/workflows/deploy.yml`.

- **PRs**: `terraform-plan` plans as the read-only `dodo-planner` account; the summary is on
  the workflow run.
- **main**: `terraform-apply` applies as `dodo-terraform`.
- **State**: `gs://<project>-tfstate`, created by `infra/bootstrap.sh`.

`lookup.sh` finds what Terraform cannot know by itself (the billing account, and resources
created before Terraform that `imports.tf` adopts). To plan locally as yourself:

```sh
cd infra/terraform
terraform init -backend-config="bucket=dodo-512722-tfstate"
export $(./lookup.sh dodo-512722)
terraform plan -lock=false
```

The deploy workflow only points the worker job at each new image; Terraform ignores the
image so the two do not fight.
