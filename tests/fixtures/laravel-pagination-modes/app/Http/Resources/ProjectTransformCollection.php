<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\ResourceCollection;

class ProjectTransformCollection extends ResourceCollection
{
    public $collects = ProjectResource::class;

    public function toArray(Request $request): array
    {
        $projects = collect($this->collection);

        return [
            'transformed' => $projects
                ->transform(function (array $project, int $index) use ($request) {
                    return [
                        'position' => $index,
                        'identifier' => $project['id'],
                        'owner' => $project['owner_email'],
                        'label' => 'transform-project',
                    ];
                })
                ->values()
                ->all(),
        ];
    }
}
