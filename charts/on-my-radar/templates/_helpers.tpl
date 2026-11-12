{{- define "omr.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "omr.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "omr.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "omr.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels for one component: app, worker or postgres. */}}
{{- define "omr.selector" -}}
app.kubernetes.io/name: {{ include "omr.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "omr.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/* The address people and agents reach this install at. It is baked into OAuth, MCP and agent-setup, so there is no default. */}}
{{- define "omr.publicUrl" -}}
{{- $u := required "publicUrl is required: the address people and agents will use, e.g. https://notes.example.com (it appears in OAuth, MCP and agent-setup URLs and cannot move once clients have seen it)" .Values.publicUrl -}}
{{- if not (regexMatch "^https?://[^/?#]+" $u) -}}
{{- fail (printf "publicUrl must be an absolute http(s) URL, got %q" $u) -}}
{{- end -}}
{{- trimSuffix "/" $u -}}
{{- end -}}

{{/* The Secret the pods read: the one you bring, or the one this chart makes. */}}
{{- define "omr.secretName" -}}
{{- default (include "omr.fullname" .) .Values.existingSecret -}}
{{- end -}}

{{/* A name for a part of this release: the full name cut to leave room for the suffix, then the suffix. Truncating the joined name instead would drop the suffix and collide with the app's. */}}
{{- define "omr.child" -}}
{{- printf "%s-%s" (include "omr.fullname" .root | trunc (int (sub 62 (len .suffix))) | trimSuffix "-") .suffix -}}
{{- end -}}

{{- define "omr.configName" -}}
{{- include "omr.child" (dict "root" . "suffix" "config") -}}
{{- end -}}

{{- define "omr.workerName" -}}
{{- include "omr.child" (dict "root" . "suffix" "worker") -}}
{{- end -}}

{{- define "omr.postgresName" -}}
{{- include "omr.child" (dict "root" . "suffix" "postgres") -}}
{{- end -}}

{{/* Pod-level hardening shared by every workload. */}}
{{- define "omr.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
fsGroup: {{ .uid }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Environment shared by app and worker. */}}
{{- define "omr.env" -}}
- name: DB_APPLICATION_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "omr.envFrom" -}}
- configMapRef:
    name: {{ include "omr.configName" . }}
- secretRef:
    name: {{ include "omr.secretName" . }}
{{- end -}}

{{- define "omr.postgresPassword" -}}
{{- $p := required "postgres.password is required when postgres.enabled=true" .Values.postgres.password -}}
{{- if not (regexMatch "^[A-Za-z0-9._~-]+$" $p) -}}
{{- fail "postgres.password may contain only letters, digits and . _ ~ - (it is placed in a connection URL)" -}}
{{- end -}}
{{- $p -}}
{{- end -}}

{{/* With the bundled Postgres, hold the pod until the database answers: the app exits when it cannot connect, which is a restart loop on a cold install. */}}
{{- define "omr.waitForPostgres" -}}
- name: wait-for-postgres
  image: {{ printf "%s:%s" .Values.postgres.image.repository .Values.postgres.image.tag | quote }}
  command:
    - sh
    - -c
    - until pg_isready -q -h {{ include "omr.postgresName" . }} -p 5432 -U onmyradar -d onmyradar; do sleep 2; done
  resources:
    requests: { cpu: 10m, memory: 16Mi }
    limits: { memory: 64Mi }
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop: ['ALL']
{{- end -}}
