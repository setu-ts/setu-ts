{{/*
Name helpers. The selector labels are generated in ONE place and consumed by the Deployment's
`spec.selector`, its pod template, the Service, and the PDB — a Service selector that matches no
pod is a defect every schema validator passes, so the labels must have a single source.
*/}}

{{- define "setu-ts.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "setu-ts.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "setu-ts.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Selector labels: the immutable subset. Never add a version here — Deployment.spec.selector
is immutable, so a label that changes between releases makes an upgrade fail. */}}
{{- define "setu-ts.selectorLabels" -}}
app.kubernetes.io/name: {{ include "setu-ts.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "setu-ts.labels" -}}
helm.sh/chart: {{ include "setu-ts.chart" . }}
{{ include "setu-ts.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "setu-ts.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "setu-ts.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
