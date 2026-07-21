#!/usr/bin/env bash
#
# thermal-log.sh —— RK3588/RK3588S 散热/频率压测采集脚本（S1 Bring-up 正式版）
#
# 用途：
#   对应 docs/checklist-s1-bringup.md §4「满栈 30 分钟散热压测（P0）」。
#   以 1Hz 采集 SoC 各 thermal_zone 温度、大核簇（Cortex-A76）频率、CPU 负载，
#   结束后自动按红线判定并生成 Markdown 报告（可选 PNG 曲线图）。
#
# 红线标准（与检查表/方案 §6 一致）：
#   ① 大核簇频率不得低于 1.8GHz 持续 5 分钟（连续 300 个 1Hz 采样点 < 1_800_000 kHz）；
#   ② 机身表面温度不得超过 45°C（红外测温枪人工测量，脚本不自动采集，
#      报告中留有填写栏位）。
#
# 用法示例：
#   bash scripts/thermal-log.sh                    # 默认 30 分钟，输出到当前目录
#   bash scripts/thermal-log.sh -d 1800 -o ~/thermal-run1
#   BIG_CORE_POLICY=policy6 bash scripts/thermal-log.sh   # 手动指定大核簇
#
# 环境：ARM64 Ubuntu 22.04/24.04（RK3588/RK3588S，如辰想 CX10A、Firefly ROC-RK3588S-PC）。
# 依赖：仅 coreutils/awk/grep/sort（bash 自带能力之外不强制额外包）；无需 root。
# Ctrl-C 中断也会基于已采集数据生成报告。
#
# 调试/测试用环境变量（正常无需设置）：
#   BIG_CORE_POLICY=policyN   跳过自动识别，手动指定大核簇
#   CPUFREQ_SYSFS=路径        覆盖 /sys/devices/system/cpu/cpufreq（仅测试用）
#   THERMAL_SYSFS=路径        覆盖 /sys/class/thermal（仅测试用）
#
set -euo pipefail

# ---------- 参数 ----------
DURATION=1800
OUTDIR="."
while getopts ":d:o:h" opt; do
  case "$opt" in
    d) DURATION="$OPTARG" ;;
    o) OUTDIR="$OPTARG" ;;
    h)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "用法：$0 [-d 秒数] [-o 输出目录]" >&2; exit 2 ;;
  esac
done

if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || [ "$DURATION" -lt 1 ]; then
  echo "错误：-d 必须为正整数秒数，当前值：$DURATION" >&2
  exit 2
fi

mkdir -p "$OUTDIR"
TS="$(date +%Y%m%d-%H%M%S)"
CSV="$OUTDIR/thermal-$TS.csv"
REPORT="$OUTDIR/thermal-$TS-report.md"
PLOT="$OUTDIR/thermal-$TS.png"

CPUFREQ="${CPUFREQ_SYSFS:-/sys/devices/system/cpu/cpufreq}"
THERMAL="${THERMAL_SYSFS:-/sys/class/thermal}"

# 红线阈值
FREQ_REDLINE_KHZ=1800000      # 1.8GHz
FREQ_REDLINE_SAMPLES=300      # 连续 300 个 1Hz 采样点 = 5 分钟

# ---------- 大核簇识别 ----------
detect_big_policy() {
  if [ -n "${BIG_CORE_POLICY:-}" ]; then
    if [ -f "$CPUFREQ/$BIG_CORE_POLICY/scaling_cur_freq" ]; then
      echo "$BIG_CORE_POLICY"
      return 0
    fi
    echo "错误：环境变量 BIG_CORE_POLICY=$BIG_CORE_POLICY 指定的簇不存在于 $CPUFREQ。" >&2
    return 1
  fi

  if [ ! -d "$CPUFREQ" ]; then
    echo "错误：未找到 $CPUFREQ —— 本机不是目标设备（RK3588 ARM64 Linux）。" >&2
    echo "请在 CX10A / Firefly ROC-RK3588S-PC 等设备上运行；如需手动指定簇，设 BIG_CORE_POLICY=policyN。" >&2
    return 1
  fi

  local best_policy="" best_max=0 p maxf
  for p in "$CPUFREQ"/policy*; do
    [ -f "$p/scaling_max_freq" ] || continue
    maxf="$(cat "$p/scaling_max_freq")"
    if [ "$maxf" -gt "$best_max" ]; then
      best_max="$maxf"
      best_policy="$(basename "$p")"
    fi
  done

  if [ -z "$best_policy" ]; then
    echo "错误：在 $CPUFREQ 下未找到任何可用 policy，无法识别大核簇。" >&2
    echo "可用 BIG_CORE_POLICY=policyN 手动指定后重试。" >&2
    return 1
  fi
  echo "$best_policy"
}

echo "== thermal-log.sh：RK3588 散热/频率压测采集 =="
if ! BIG_POLICY="$(detect_big_policy)"; then
  echo "冒烟/提示：大核簇识别失败，已优雅退出（在目标设备上本步骤应成功）。" >&2
  exit 1
fi

BIG_DIR="$CPUFREQ/$BIG_POLICY"
BIG_CPUS="$(cat "$BIG_DIR/related_cpus" 2>/dev/null || echo '?')"
echo "大核簇识别结果：$BIG_POLICY（related_cpus: $BIG_CPUS，scaling_max_freq: $(cat "$BIG_DIR/scaling_max_freq") kHz）"

# ---------- thermal_zone 枚举 ----------
ZONES=()
ZONE_TYPES=()
if [ -d "$THERMAL" ]; then
  for z in "$THERMAL"/thermal_zone*; do
    [ -f "$z/temp" ] || continue
    ZONES+=("$z")
    ZONE_TYPES+=("$(cat "$z/type" 2>/dev/null || echo unknown)")
  done
fi
if [ "${#ZONES[@]}" -eq 0 ]; then
  echo "警告：未发现 thermal_zone，温度列将只记 NA。" >&2
fi
echo "温度采集点："
for i in "${!ZONES[@]}"; do
  echo "  $(basename "${ZONES[$i]}") -> ${ZONE_TYPES[$i]}"
done

# 全簇列表（记录每簇频率）
POLICIES=()
for p in "$CPUFREQ"/policy*; do
  [ -f "$p/scaling_cur_freq" ] && POLICIES+=("$(basename "$p")")
done

# ---------- CSV 头 ----------
{
  printf 'epoch,iso8601,loadavg'
  for t in "${ZONE_TYPES[@]}"; do printf ',%s_mC' "$t"; done
  printf ',big_freq_khz'
  for p in "${POLICIES[@]}"; do printf ',%s_khz' "$p"; done
  printf '\n'
} > "$CSV"

echo "采集时长：${DURATION}s（1Hz），输出：$CSV"
echo "压测负载请另行构造（检查表 §4.1：会议 UI + 3 agent + ASR + 最高亮度 + stress-ng 补载）。"
echo "按 Ctrl-C 可提前结束，仍会基于已采集数据生成报告。"

START_EPOCH="$(date +%s)"
INTERRUPTED="no"

# ---------- 报告生成（先定义，供 trap 与正常结束共用） ----------
generate_report() {
  local rows
  rows=$(($(wc -l < "$CSV") - 1))
  if [ "$rows" -lt 2 ]; then
    echo "采集数据不足（${rows} 行），跳过报告生成。" >&2
    return 0
  fi

  local end_epoch elapsed
  end_epoch="$(date +%s)"
  elapsed=$((end_epoch - START_EPOCH))

  # 定位列号
  local header big_col
  header="$(head -1 "$CSV")"
  big_col=$(awk -F',' '{for(i=1;i<=NF;i++) if($i=="big_freq_khz") print i}' <<<"$header")
  # 温度列：第 4 列起到 big_freq_khz 前一列（loadavg 是第 3 列）
  local first_temp_col=4
  local last_temp_col=$((big_col - 1))

  # 温度统计（所有 zone 的毫摄氏度一起算 max/avg）
  read -r TEMP_MAX TEMP_AVG <<<"$(tail -n +2 "$CSV" | awk -F',' -v a="$first_temp_col" -v b="$last_temp_col" '
    { for(i=a;i<=b;i++){ if($i=="NA") continue; n++; s+=$i; if($i>mx) mx=$i } }
    END { if(n>0) printf "%d %.0f", mx, s/n; else print "NA NA" }')"

  # 大核频率统计 min/avg
  read -r FREQ_MIN FREQ_AVG <<<"$(tail -n +2 "$CSV" | awk -F',' -v c="$big_col" '
    $c!="NA" { n++; s+=$c; if(n==1||$c<mn) mn=$c }
    END { if(n>0) printf "%d %.0f", mn, s/n; else print "NA NA" }')"

  # p5（近似：排序后第 5 百分位）
  FREQ_P5=$(tail -n +2 "$CSV" | awk -F',' -v c="$big_col" '$c!="NA"{print $c}' \
    | sort -n | awk -v n="$rows" 'NR==int(n*0.05)+1{print; exit} END{if(NR==0)print "NA"}')

  # 撞线判定：连续 <1.8GHz 的最长采样段
  LONGEST_BELOW=$(tail -n +2 "$CSV" | awk -F',' -v c="$big_col" -v th="$FREQ_REDLINE_KHZ" '
    $c!="NA" { if($c<th){cur++; if(cur>mx)mx=cur} else cur=0 }
    END { print mx+0 }')

  local verdict verdict_reason
  if [ "$LONGEST_BELOW" -ge "$FREQ_REDLINE_SAMPLES" ]; then
    verdict="FAIL（撞线）"
    verdict_reason="大核频率连续 ${LONGEST_BELOW} 个采样点（约 ${LONGEST_BELOW}s）低于 1.8GHz，超过红线（连续 ≥${FREQ_REDLINE_SAMPLES} 点 / 5 分钟）。触发 B 计划（RK3588S / 均热板加厚 / 风扇），见方案 §6。"
  else
    verdict="PASS"
    verdict_reason="大核频率低于 1.8GHz 的最长连续段为 ${LONGEST_BELOW} 个采样点（约 ${LONGEST_BELOW}s），未达红线（${FREQ_REDLINE_SAMPLES} 点）。表面温度项需人工测温后补判。"
  fi

  local model memtotal uname_s
  model="$(cat /proc/device-tree/model 2>/dev/null | tr -d '\0' || true)"
  [ -z "$model" ] && model="未知"
  memtotal="$(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo 2>/dev/null || true)"
  [ -z "$memtotal" ] && memtotal="未知"
  uname_s="$(uname -a)"

  {
    echo "# 散热/频率压测报告（S1 §4 P0）"
    echo
    echo "- 生成时间：$(date '+%Y-%m-%d %H:%M:%S')"
    echo "- 中断状态：$([ "$INTERRUPTED" = yes ] && echo '被 Ctrl-C 提前中断（数据为部分采集）' || echo '完整采集')"
    echo
    echo "## 设备信息"
    echo
    echo "- 型号：$model"
    echo "- uname：\`$uname_s\`"
    echo "- 内存：$memtotal"
    echo "- 大核簇：$BIG_POLICY（related_cpus: $BIG_CPUS）"
    echo
    echo "## 采集概况"
    echo
    echo "- 计划时长：${DURATION}s；实际采集：${rows} 个采样点（约 ${elapsed}s）"
    echo "- CSV：\`$(basename "$CSV")\`"
    echo
    echo "## SoC 温度（全部 thermal_zone 汇总）"
    echo
    if [ "$TEMP_MAX" != "NA" ]; then
      echo "- 最高：$((TEMP_MAX / 1000))°C"
      echo "- 平均：$((TEMP_AVG / 1000))°C"
    else
      echo "- 无温度数据（本机无 thermal_zone）"
    fi
    echo
    echo "## 大核簇频率"
    echo
    if [ "$FREQ_MIN" != "NA" ]; then
      echo "- 最低：$((FREQ_MIN / 1000)) MHz"
      echo "- 平均：$((FREQ_AVG / 1000)) MHz"
      echo "- p5（近似第 5 百分位）：$((FREQ_P5 / 1000)) MHz"
    else
      echo "- 无频率数据"
    fi
    echo
    echo "## 撞线判定"
    echo
    echo "- **结论：$verdict**"
    echo "- 依据：$verdict_reason"
    echo
    echo "## 机身表面温度（人工红外测温填写，红线 ≤45°C）"
    echo
    echo "| 时间点 | 背板中心 °C | 握持区 °C | 备注 |"
    echo "|---|---|---|---|"
    echo "| 5 min |  |  |  |"
    echo "| 10 min |  |  |  |"
    echo "| 15 min |  |  |  |"
    echo "| 20 min |  |  |  |"
    echo "| 25 min |  |  |  |"
    echo "| 30 min |  |  |  |"
    echo
    echo "- 表面温度最终判定（过/撞线）：______"
    echo
    echo "## 附录：判定阈值（checklist-s1-bringup.md §4）"
    echo
    echo "- 大核频率红线：< ${FREQ_REDLINE_KHZ} kHz（1.8GHz）持续 ≥ ${FREQ_REDLINE_SAMPLES} 个 1Hz 采样点（5 分钟）"
    echo "- 表面温度红线：> 45°C（人工测量）"
    echo "- 撞线处置：触发 B 计划（RK3588S / 均热板加厚 / 风扇），结论必须先于 S2 ODM 谈判（方案 §6 / R4）"
  } > "$REPORT"

  echo "报告已生成：$REPORT"
  echo "判定结论：$verdict"

  # ---------- 可选 PNG 曲线 ----------
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import matplotlib' 2>/dev/null; then
    CSV_PATH="$CSV" PLOT_PATH="$PLOT" python3 - <<'PY' || echo "警告：曲线图生成失败，跳过（不影响判定）。" >&2
import csv, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

csv_path = os.environ["CSV_PATH"]; plot_path = os.environ["PLOT_PATH"]
t, freq, temp = [], [], []
with open(csv_path) as f:
    for row in csv.DictReader(f):
        t.append(int(row["epoch"]))
        try:
            freq.append(int(row["big_freq_khz"]) / 1e6)
        except (ValueError, KeyError):
            freq.append(None)
        vals = [int(v) for k, v in row.items()
                if k.endswith("_mC") and v not in ("NA", "", None)]
        temp.append(max(vals) / 1000.0 if vals else None)

t0 = t[0]; x = [(v - t0) / 60.0 for v in t]
fig, ax1 = plt.subplots(figsize=(10, 5))
ax1.plot(x, freq, color="tab:blue", label="big-core freq (GHz)")
ax1.axhline(1.8, color="tab:blue", ls="--", lw=1, label="redline 1.8GHz")
ax1.set_xlabel("minutes"); ax1.set_ylabel("GHz", color="tab:blue")
ax2 = ax1.twinx()
ax2.plot(x, temp, color="tab:red", label="SoC temp (C)")
ax2.set_ylabel("C", color="tab:red")
fig.legend(loc="upper right", bbox_to_anchor=(0.9, 0.9))
fig.tight_layout()
fig.savefig(plot_path, dpi=120)
print("曲线图已生成：" + plot_path)
PY
  else
    echo "提示：未检测到 python3 + matplotlib，跳过曲线图（可选，不影响判定）。"
  fi
}

# ---------- 采集循环 ----------
collect_loop() {
  local i epoch iso load tvals fvals
  for ((i=0; i<DURATION; i++)); do
    epoch="$(date +%s)"
    iso="$(date '+%Y-%m-%d %H:%M:%S')"
    load="$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo NA)"
    tvals=""
    for z in "${ZONES[@]}"; do
      tvals+=",$(cat "$z/temp" 2>/dev/null || echo NA)"
    done
    fvals=",$(cat "$BIG_DIR/scaling_cur_freq" 2>/dev/null || echo NA)"
    for p in "${POLICIES[@]}"; do
      fvals+=",$(cat "$CPUFREQ/$p/scaling_cur_freq" 2>/dev/null || echo NA)"
    done
    printf '%s,%s,%s%s%s\n' "$epoch" "$iso" "$load" "$tvals" "$fvals" >> "$CSV"
    sleep 1
  done
}

cleanup() {
  if kill -0 "$COLLECT_PID" 2>/dev/null; then
    kill "$COLLECT_PID" 2>/dev/null || true
    wait "$COLLECT_PID" 2>/dev/null || true
    INTERRUPTED="yes"
  fi
  generate_report
}

collect_loop &
COLLECT_PID=$!
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "采集循环已启动（PID $COLLECT_PID）。"
wait "$COLLECT_PID" 2>/dev/null || true
exit 0
