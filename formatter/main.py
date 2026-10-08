import re
import sys
import defaultKwargs
from krl import Formatter


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    kwargs = dict()
    if len(sys.argv) < 2:
        usage = 'usage: formatter.py filename [options...]\n'
        opt = '  OPTIONS:\n'
        for key in defaultKwargs.kwargs:
            val = defaultKwargs.kwargs[key]
            key_type = re.match(r'\<class \'(.*)\'\>', str(type(val))).group(1)
            key_type = key_type.replace('NoneType', 'int')
            opt += '    --%s=%s\n' % (key, key_type)

        print('%s%s' % (usage, opt), file=sys.stderr)

    else:
        for arg in sys.argv[1:]:
            if '=' not in arg:
                continue
            key, value = arg.split('=', 1)
            key = key.replace('--', '').strip()
            # strip surrounding quotes (e.g. --filename="C:\path\file.src")
            value = value.strip().strip('"').strip("'")
            if key == 'filename':
                pass
            elif value.lower() == 'false':
                value = False
            elif value.lower() == 'true':
                value = True
            elif re.match(r'^-?\d+$', value):
                value = int(value)
            elif re.match(r'^-?\d+\.\d+$', value):
                value = float(value)
            kwargs[key] = value
        formatter = Formatter(**kwargs)
        formatter.formatFile()


if __name__ == '__main__':
    main()
